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
