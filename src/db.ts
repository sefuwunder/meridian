// meridian — sqlite store (bun:sqlite, zero deps).
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

const DIR = new URL("../data/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

export const db = new Database(DIR + "meridian.db", { create: true });
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`
CREATE TABLE IF NOT EXISTS recons (
  id TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  lat REAL, lon REAL, country TEXT, country_code TEXT,
  status TEXT NOT NULL DEFAULT 'collecting',
  progress_json TEXT NOT NULL DEFAULT '{}',
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  facts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);

export interface ReconRow {
  id: string; city: string;
  lat: number | null; lon: number | null; country: string | null; country_code: string | null;
  status: string; progress_json: string; nodes_json: string; edges_json: string;
  sources_json: string; facts_json: string; created_at: number; updated_at: number;
}

const now = () => Date.now();

export function createRecon(id: string, city: string, sources: any[]): void {
  db.query(
    `INSERT INTO recons (id, city, status, sources_json, created_at, updated_at)
     VALUES (?, ?, 'collecting', ?, ?, ?)`
  ).run(id, city, JSON.stringify(sources), now(), now());
}

export function getRecon(id: string): ReconRow | null {
  return db.query(`SELECT * FROM recons WHERE id = ?`).get(id) as ReconRow | null;
}

export function listRecons(): any[] {
  return db.query(
    `SELECT id, city, country, status, created_at, updated_at,
            json_array_length(nodes_json) AS nodes, json_array_length(edges_json) AS edges
     FROM recons ORDER BY created_at DESC LIMIT 50`
  ).all();
}

export function updateRecon(id: string, patch: Record<string, any>): void {
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
  db.query(`UPDATE recons SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(patch), now(), id);
}

export function deleteRecon(id: string): void {
  db.query(`DELETE FROM recons WHERE id = ?`).run(id);
}

export function fullRecon(row: ReconRow): any {
  return {
    id: row.id, city: row.city, lat: row.lat, lon: row.lon,
    country: row.country, country_code: row.country_code, status: row.status,
    progress: JSON.parse(row.progress_json || "{}"),
    nodes: JSON.parse(row.nodes_json || "[]"),
    edges: JSON.parse(row.edges_json || "[]"),
    sources: JSON.parse(row.sources_json || "[]"),
    facts: JSON.parse(row.facts_json || "{}"),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

// ---------- enrichment jobs ----------
// Long-running company enrichments (scrape + registry fold-in) persist here
// so the chat client (milton) can poll GET /api/enrich/:id. Jobs are
// fire-and-forget from the requester's view: POST returns immediately and
// the background runner updates status/progress/result.

db.exec(`
CREATE TABLE IF NOT EXISTS enrich_jobs (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);

export interface EnrichJobRow {
  id: string; query: string; status: string; progress_json: string;
  result_json: string | null; nodes_json: string; edges_json: string;
  error: string | null; created_at: number; updated_at: number;
}

export function createEnrichJob(id: string, query: string): void {
  db.query(
    `INSERT INTO enrich_jobs (id, query, status, progress_json, created_at, updated_at)
     VALUES (?, ?, 'running', '{}', ?, ?)`
  ).run(id, query, now(), now());
}

export function getEnrichJob(id: string): EnrichJobRow | null {
  return db.query(`SELECT * FROM enrich_jobs WHERE id = ?`).get(id) as EnrichJobRow | null;
}

export function listEnrichJobs(): any[] {
  return db.query(
    `SELECT id, query, status, created_at, updated_at FROM enrich_jobs
     ORDER BY created_at DESC LIMIT 50`
  ).all();
}

export function updateEnrichJob(id: string, patch: Record<string, any>): void {
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
  db.query(`UPDATE enrich_jobs SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(patch), now(), id);
}

// ---------- prospecting jobs ----------
// Territory-prospecting jobs: find companies by location + industry
// (a salesperson building a book of business). Same fire-and-forget shape
// as enrich_jobs: POST returns immediately, the background runner updates
// status/progress/result, and milton polls GET /api/prospect/:id.

db.exec(`
CREATE TABLE IF NOT EXISTS prospect_jobs (
  id TEXT PRIMARY KEY,
  location TEXT NOT NULL,
  industry TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);

export interface ProspectJobRow {
  id: string; location: string; industry: string; status: string;
  progress_json: string; result_json: string | null;
  nodes_json: string; edges_json: string;
  error: string | null; created_at: number; updated_at: number;
}

export function createProspectJob(id: string, location: string, industry: string): void {
  db.query(
    `INSERT INTO prospect_jobs (id, location, industry, status, progress_json, created_at, updated_at)
     VALUES (?, ?, ?, 'running', '{}', ?, ?)`
  ).run(id, location, industry, now(), now());
}

export function getProspectJob(id: string): ProspectJobRow | null {
  return db.query(`SELECT * FROM prospect_jobs WHERE id = ?`).get(id) as ProspectJobRow | null;
}

export function listProspectJobs(): any[] {
  return db.query(
    `SELECT id, location, industry, status, created_at, updated_at,
            COALESCE(json_array_length(result_json, '$.companies'), 0) AS company_count
     FROM prospect_jobs ORDER BY created_at DESC LIMIT 50`
  ).all();
}

export function updateProspectJob(id: string, patch: Record<string, any>): void {
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
  db.query(`UPDATE prospect_jobs SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(patch), now(), id);
}

export function fullProspectJob(row: ProspectJobRow): any {
  let result: any = null, progress: any = {};
  try { if (row.result_json) result = JSON.parse(row.result_json); } catch { /* keep null */ }
  try { progress = JSON.parse(row.progress_json || "{}"); } catch { /* keep {} */ }
  return {
    id: row.id, location: row.location, industry: row.industry,
    status: row.status, progress,
    error: row.error,
    companies: result?.companies ?? [],
    nodes: JSON.parse(row.nodes_json || "[]"),
    edges: JSON.parse(row.edges_json || "[]"),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
export function fullEnrichJob(row: EnrichJobRow): any {
  let result: any = null, progress: any = {};
  try { if (row.result_json) result = JSON.parse(row.result_json); } catch { /* keep null */ }
  try { progress = JSON.parse(row.progress_json || "{}"); } catch { /* keep {} */ }
  return {
    id: row.id, query: row.query, status: row.status, progress,
    error: row.error,
    company: result?.company ?? null,
    principals: result?.principals ?? null,
    notes: result?.notes ?? [],
    nodes: JSON.parse(row.nodes_json || "[]"),
    edges: JSON.parse(row.edges_json || "[]"),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
