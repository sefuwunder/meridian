// meridian — case files. Named, durable snapshots of the working graph
// (nodes, edges, analyst notes, groups, dossier facts, per-source states).
//
// Cases live in data/cases/ (gitignored, mode 0600) — recon data is never
// committed to the public repo. They are the durable layer for analysis
// work: merges, groups, and note edits mark the view dirty until saved.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import type { GNode, GEdge } from "./sources";
import type { GGroup } from "./graph";

const DIR = new URL("../data/cases/", import.meta.url).pathname;

export interface CaseFile {
  id: string;
  name: string;
  city: string;
  country: string | null;
  country_code?: string | null;
  lat?: number | null;
  lon?: number | null;
  cityId?: string;
  facts: Record<string, any>;
  sources: any[];
  nodes: GNode[];
  edges: GEdge[];
  groups: GGroup[];
  version: 1;
  created_at: number;
  updated_at: number;
}

export interface CaseSummary {
  id: string; name: string; city: string;
  nodes: number; edges: number; groups: number;
  created_at: number; updated_at: number;
}

export interface CaseSnapshot {
  city: string; country: string | null; country_code?: string | null;
  lat?: number | null; lon?: number | null; cityId?: string;
  facts: Record<string, any>; sources: any[];
  nodes: GNode[]; edges: GEdge[]; groups: GGroup[];
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("bad case id");
  return id;
}

function summarize(c: CaseFile): CaseSummary {
  return {
    id: c.id, name: c.name, city: c.city || "",
    nodes: Array.isArray(c.nodes) ? c.nodes.length : 0,
    edges: Array.isArray(c.edges) ? c.edges.length : 0,
    groups: Array.isArray(c.groups) ? c.groups.length : 0,
    created_at: c.created_at, updated_at: c.updated_at,
  };
}

export function listCases(): CaseSummary[] {
  mkdirSync(DIR, { recursive: true });
  const out: CaseSummary[] = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(summarize(JSON.parse(readFileSync(DIR + f, "utf8")) as CaseFile));
    } catch { /* skip corrupt files */ }
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

export function getCase(id: string): CaseFile | null {
  mkdirSync(DIR, { recursive: true });
  try {
    return JSON.parse(readFileSync(DIR + safeId(id) + ".json", "utf8")) as CaseFile;
  } catch {
    return null;
  }
}

export function saveCase(name: string, s: CaseSnapshot): CaseFile {
  mkdirSync(DIR, { recursive: true });
  const now = Date.now();
  const id = "c" + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const c: CaseFile = {
    id,
    name: name.trim().slice(0, 120),
    city: s.city || "",
    country: s.country ?? null,
    country_code: s.country_code ?? null,
    lat: s.lat ?? null,
    lon: s.lon ?? null,
    cityId: s.cityId || "",
    facts: s.facts || {},
    sources: Array.isArray(s.sources) ? s.sources : [],
    nodes: s.nodes,
    edges: s.edges,
    groups: Array.isArray(s.groups) ? s.groups : [],
    version: 1,
    created_at: now,
    updated_at: now,
  };
  writeFileSync(DIR + id + ".json", JSON.stringify(c), { mode: 0o600 });
  return c;
}

export function deleteCase(id: string): boolean {
  try {
    unlinkSync(DIR + safeId(id) + ".json");
    return true;
  } catch {
    return false;
  }
}
