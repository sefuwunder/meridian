// meridian — run-request router for outside consumers (e.g. Milton).
//
// A "run" is a recon plus router metadata: it reuses the exact same
// runRecon machinery as POST /api/recon, but router runs execute one at a
// time, FIFO. When a run finishes (success or failure) and a callback_url
// was supplied, the router POSTs a result payload to it once.
//
// No auth: the router is for trusted local consumers only.

import { db, createRecon, getRecon } from "./db";
import { SOURCE_DEFS, BUSINESS_SOURCES } from "./sources";

db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  recon_id TEXT NOT NULL,
  city TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  sources_json TEXT NOT NULL DEFAULT '[]',
  callback_url TEXT,
  callback_headers_json TEXT NOT NULL DEFAULT '{}',
  callback_state TEXT NOT NULL DEFAULT 'skipped',
  callback_status INTEGER,
  callback_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);`);

// Migration: scope flag for business-only runs (Milton-initiated). SQLite
// has no ADD COLUMN IF NOT EXISTS, so check first.
{
  const cols = db.query(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "business_only"))
    db.exec(`ALTER TABLE runs ADD COLUMN business_only INTEGER NOT NULL DEFAULT 0`);
}

const now = () => Date.now();

export interface RunRow {
  id: string; recon_id: string; city: string; label: string | null;
  status: string; sources_json: string; business_only: number;
  callback_url: string | null; callback_headers_json: string;
  callback_state: string; callback_status: number | null; callback_at: number | null;
  created_at: number; started_at: number | null; finished_at: number | null;
}

// ---------------------------------------------------------------- validation

export interface ValidatedRun {
  city: string;
  wanted: string[];          // source keys, geocode ensured later
  label: string | null;
  businessOnly: boolean;     // true: business-data sources only (+ geocode plumbing)
  callbackUrl: string | null;
  callbackHeaders: Record<string, string>;
}

// Strict header validation, mirroring the exec-crm webhook pattern.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FRAMING = new Set(["host", "content-length", "connection", "transfer-encoding"]);
const MAX_HEADERS = 20;
const MAX_HV_BYTES = 2048;

export function validateCallbackUrl(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("callback_url must be a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("callback_url must be http(s)");
  return u.toString();
}

export function validateCallbackHeaders(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v))
    throw new Error("callback_headers must be an object");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_HEADERS)
    throw new Error(`at most ${MAX_HEADERS} callback headers`);
  const out: Record<string, string> = {};
  for (const [k, raw] of entries) {
    const name = String(k);
    const value = String(raw ?? "");
    if (!TOKEN_RE.test(name))
      throw new Error(`invalid callback header name: ${name.slice(0, 60)}`);
    if (FRAMING.has(name.toLowerCase()))
      throw new Error(`framing header not allowed: ${name}`);
    if (Buffer.byteLength(name) > MAX_HV_BYTES || Buffer.byteLength(value) > MAX_HV_BYTES)
      throw new Error(`callback header too long: ${name.slice(0, 60)}`);
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value))
      throw new Error("CR/LF not allowed in callback headers");
    out[name] = value;
  }
  return out;
}

export function validateRunInput(b: any): ValidatedRun {
  const city = String(b?.city ?? "").trim();
  if (!city) throw new Error("city is required");
  if (city.length > 200) throw new Error("city too long");
  let wanted = SOURCE_DEFS.map((d) => d.key);
  if (Array.isArray(b?.sources)) {
    const filtered = b.sources
      .map((k: unknown) => String(k))
      .filter((k: string) => SOURCE_DEFS.some((d) => d.key === k));
    if (filtered.length) wanted = filtered; // all-unknown → fall back to all sources
  }
  const businessOnly = b?.business_only === true;
  if (businessOnly) {
    wanted = applyBusinessOnly(wanted);
    if (!wanted.some((k) => BUSINESS_SOURCES.has(k)))
      throw new Error("business_only: none of the requested sources emit business data");
  }
  const rawLabel = b?.label;
  const label = rawLabel === undefined || rawLabel === null
    ? null
    : String(rawLabel).trim().slice(0, 120) || null;
  return {
    city,
    wanted,
    label,
    businessOnly,
    callbackUrl: validateCallbackUrl(b?.callback_url),
    callbackHeaders: validateCallbackHeaders(b?.callback_headers),
  };
}

// Business-only scope: keep geocode plumbing plus sources classified as
// business data. Shared by POST /api/runs and POST /api/recon.
export function applyBusinessOnly(wanted: string[]): string[] {
  return wanted.filter((k) => k === "geocode" || BUSINESS_SOURCES.has(k));
}

// ------------------------------------------------------------------- storage

export function getRun(id: string): RunRow | null {
  return db.query(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | null;
}

export function listRuns(): any[] {
  return db.query(`
    SELECT r.id AS run_id, r.recon_id, r.city, r.label, r.status,
           r.business_only AS business_only,
           r.created_at, r.started_at, r.finished_at,
           COALESCE(json_array_length(rc.nodes_json), 0) AS nodes,
           COALESCE(json_array_length(rc.edges_json), 0) AS edges
    FROM runs r LEFT JOIN recons rc ON rc.id = r.recon_id
    ORDER BY r.created_at DESC LIMIT 100
  `).all();
}

const countJson = (s: string | null | undefined): number => {
  try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.length : 0; }
  catch { return 0; }
};

export function runDetail(id: string, origin: string): any | null {
  const run = getRun(id);
  if (!run) return null;
  const recon = getRecon(run.recon_id);
  const o = (origin || "").replace(/\/$/, "");
  const finished = ["ready", "partial", "failed"].includes(run.status);
  return {
    run_id: run.id,
    recon_id: run.recon_id,
    city: run.city,
    label: run.label,
    status: run.status,
    business_only: run.business_only === 1,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    progress: recon ? JSON.parse(recon.progress_json || "{}") : {},
    sources: recon ? JSON.parse(recon.sources_json || "[]") : [],
    result: finished ? {
      nodes: recon ? countJson(recon.nodes_json) : 0,
      edges: recon ? countJson(recon.edges_json) : 0,
      recon_url: `${o}/api/recon/${run.recon_id}`,
      export_url: `${o}/api/recon/${run.recon_id}/export`,
    } : null,
    // Header VALUES are secrets: only names are ever exposed.
    callback: {
      url: run.callback_url,
      headers: Object.keys(JSON.parse(run.callback_headers_json || "{}")),
      state: run.callback_state,
      http_status: run.callback_status,
      attempted_at: run.callback_at,
    },
  };
}

// --------------------------------------------------------------------- queue

// The starter runs one recon through the server's existing background
// machinery. Registered by server.ts to avoid a circular import.
type Starter = (reconId: string, city: string, wanted: string[]) => Promise<void>;
let starter: Starter | null = null;
let base = "http://localhost:3005";
let active = false;

export function initRouter(opts: { starter: Starter; base: string }): void {
  starter = opts.starter;
  base = opts.base;
  // Boot recovery: anything stuck in running/queued from a previous process
  // goes back to queued — never silently dropped, never auto-run twice.
  db.query(`UPDATE runs SET status = 'queued' WHERE status IN ('running','queued')`).run();
  const pending = db.query(`SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'`).get() as { n: number };
  if (pending.n > 0) void pumpQueue();
}

export function setRouterBase(b: string): void { base = b; }

export function requestRun(v: ValidatedRun): { run_id: string; status: string } {
  const wanted = v.wanted.includes("geocode") ? [...v.wanted] : ["geocode", ...v.wanted];
  const reconId = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const states = SOURCE_DEFS.filter((d) => wanted.includes(d.key))
    .map((d) => ({ key: d.key, label: d.label, state: "pending", note: "", ms: 0 }));
  createRecon(reconId, v.city, states);
  const runId = "run_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  db.query(
    `INSERT INTO runs (id, recon_id, city, label, status, sources_json, business_only,
                       callback_url, callback_headers_json, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
  ).run(runId, reconId, v.city, v.label, JSON.stringify(wanted),
    v.businessOnly ? 1 : 0, v.callbackUrl, JSON.stringify(v.callbackHeaders), now());
  // pumpQueue starts the run synchronously up to its first await, so the
  // status we read back here is already 'running' unless another run is
  // active, in which case it stays 'queued'.
  void pumpQueue();
  const row = getRun(runId);
  return { run_id: runId, status: row ? row.status : "queued" };
}

async function pumpQueue(): Promise<void> {
  if (active || !starter) return;
  active = true;
  try {
    for (;;) {
      const next = db.query(
        `SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
      ).get() as RunRow | null;
      if (!next) break;
      await executeRun(next);
    }
  } finally {
    active = false;
  }
}

async function executeRun(run: RunRow): Promise<void> {
  db.query(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`)
    .run(now(), run.id);
  const wanted: string[] = JSON.parse(run.sources_json || "[]");
  try {
    await starter!(run.recon_id, run.city, wanted);
  } catch {
    // runRecon never rejects (it catches per-source and per-job), but a
    // failed starter must still finish the run record, never hang the queue.
  }
  const recon = getRecon(run.recon_id);
  const rs = recon?.status;
  const status = rs === "ready" ? "ready" : rs === "partial" ? "partial" : "failed";
  db.query(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`)
    .run(status, now(), run.id);
  await deliverCallback(run, {
    run_id: run.id,
    city: run.city,
    label: run.label,
    status,
    nodes: recon ? countJson(recon.nodes_json) : 0,
    edges: recon ? countJson(recon.edges_json) : 0,
  });
  // A failed callback never fails the run: deliverCallback records the
  // outcome and never throws.
}

// ---------------------------------------------------------- completion hook

async function deliverCallback(run: RunRow, payload: Record<string, unknown>): Promise<void> {
  const mark = (state: string, httpStatus: number | null) => {
    db.query(`UPDATE runs SET callback_state = ?, callback_status = ?, callback_at = ? WHERE id = ?`)
      .run(state, httpStatus, now(), run.id);
  };
  if (!run.callback_url) { mark("skipped", null); return; }
  const origin = base.replace(/\/$/, "");
  const body = JSON.stringify({
    ...payload,
    result_url: `${origin}/api/recon/${run.recon_id}`,
    export_url: `${origin}/api/recon/${run.recon_id}/export`,
  });
  const custom: Record<string, string> = JSON.parse(run.callback_headers_json || "{}");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(custom)) {
    if (FRAMING.has(k.toLowerCase())) continue; // defense in depth
    headers[k] = v; // custom wins, case-insensitively where the receiver cares
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(run.callback_url, {
      method: "POST", headers, body, signal: ctrl.signal,
    });
    mark(res.ok ? "delivered" : "failed", res.status);
  } catch {
    mark("failed", null);
  } finally {
    clearTimeout(t);
  }
}
