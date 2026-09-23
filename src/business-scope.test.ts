// meridian — business-only scope tests: source classification, the
// exhaustiveness guard, and the /api/runs + /api/recon filtering path.
// DB rows created here are deleted in afterEach (same pattern as prospect.test.ts).
import { test, expect, afterEach } from "bun:test";
import { SOURCE_DEFS, BUSINESS_SOURCES } from "./sources";
import {
  validateRunInput, applyBusinessOnly, requestRun, getRun, runDetail, listRuns,
} from "./router";
import { db } from "./db";

const createdRuns: string[] = [];
const createdRecons: string[] = [];

afterEach(() => {
  for (const id of createdRuns) {
    const run = getRun(id);
    if (run) createdRecons.push(run.recon_id);
    db.query(`DELETE FROM runs WHERE id = ?`).run(id);
  }
  createdRuns.length = 0;
  for (const id of createdRecons) db.query(`DELETE FROM recons WHERE id = ?`).run(id);
  createdRecons.length = 0;
});

// ---------- exhaustiveness guard ----------

test("every SOURCE_DEFS entry carries an explicit business boolean", () => {
  expect(SOURCE_DEFS.length).toBeGreaterThan(0);
  for (const d of SOURCE_DEFS) {
    expect(typeof d.business, `${d.key} must have an explicit business boolean`).toBe("boolean");
  }
});

test("SOURCE_DEFS keys are unique", () => {
  const keys = SOURCE_DEFS.map((d) => d.key);
  expect(new Set(keys).size).toBe(keys.length);
});

// ---------- allowlist snapshot ----------
// Pinned deliberately: changing a source's classification must update this
// test as a conscious act, never silently.
const EXPECTED_BUSINESS = [
  "overpass", "business", "gleif", "nonprofits", "fdic",
  "gleifname", "secedgar", "wikidataorg", "hkcr", "enhetsregisteret",
  "parallel-entities",
];

test("business allowlist is exactly the audited set", () => {
  expect([...BUSINESS_SOURCES].sort()).toEqual([...EXPECTED_BUSINESS].sort());
});

test("geocode is plumbing, not business data", () => {
  expect(BUSINESS_SOURCES.has("geocode")).toBe(false);
  expect(SOURCE_DEFS.find((d) => d.key === "geocode")!.business).toBe(false);
});

// ---------- applyBusinessOnly ----------

test("applyBusinessOnly keeps geocode + business sources, drops the rest", () => {
  const out = applyBusinessOnly(["geocode", "news", "business", "people", "gleif", "weather"]);
  expect(out).toEqual(["geocode", "business", "gleif"]);
});

test("applyBusinessOnly on the full key list yields allowlist + geocode", () => {
  const out = applyBusinessOnly(SOURCE_DEFS.map((d) => d.key));
  expect(out).toContain("geocode");
  expect(out.filter((k) => k !== "geocode").sort()).toEqual([...EXPECTED_BUSINESS].sort());
});

// ---------- validateRunInput ----------

test("business_only:true restricts wanted to the allowlist", () => {
  const v = validateRunInput({ city: "Austin", business_only: true });
  expect(v.businessOnly).toBe(true);
  expect(v.wanted).toContain("geocode");
  for (const k of v.wanted) {
    expect(k === "geocode" || BUSINESS_SOURCES.has(k), k).toBe(true);
  }
});

test("full mode is unaffected: businessOnly false, all sources", () => {
  const v = validateRunInput({ city: "Austin" });
  expect(v.businessOnly).toBe(false);
  expect(v.wanted).toEqual(SOURCE_DEFS.map((d) => d.key));
});

test("business_only with explicit mixed sources intersects to business ones", () => {
  const v = validateRunInput({ city: "Austin", business_only: true, sources: ["news", "business", "nope"] });
  expect(v.wanted).toEqual(["business"]);
});

test("business_only with no business sources in the list fails loudly", () => {
  expect(() => validateRunInput({ city: "Austin", business_only: true, sources: ["news", "people"] }))
    .toThrow("business_only");
});

test("business_only truthiness is strict: only === true counts", () => {
  expect(validateRunInput({ city: "Austin", business_only: 1 as any }).businessOnly).toBe(false);
  expect(validateRunInput({ city: "Austin", business_only: "yes" as any }).businessOnly).toBe(false);
});

// ---------- requestRun → storage → runDetail ----------

test("business_only run stores the scope and runDetail exposes it", () => {
  const v = validateRunInput({ city: "Testville", business_only: true, label: "milton" });
  const { run_id } = requestRun(v);
  createdRuns.push(run_id);
  const run = getRun(run_id);
  expect(run).not.toBeNull();
  expect(run!.business_only).toBe(1);
  const wanted: string[] = JSON.parse(run!.sources_json);
  expect(wanted).toContain("geocode");
  for (const k of wanted) expect(k === "geocode" || BUSINESS_SOURCES.has(k), k).toBe(true);
  const d = runDetail(run_id, "http://localhost:3005");
  expect(d).not.toBeNull();
  expect(d.business_only).toBe(true);
  for (const s of d.sources) expect(s.key === "geocode" || BUSINESS_SOURCES.has(s.key), s.key).toBe(true);
});

test("full-mode run stores business_only false with all sources", () => {
  const v = validateRunInput({ city: "Testville" });
  const { run_id } = requestRun(v);
  createdRuns.push(run_id);
  const d = runDetail(run_id, "http://localhost:3005");
  expect(d.business_only).toBe(false);
  const wanted: string[] = JSON.parse(getRun(run_id)!.sources_json);
  expect(wanted).toEqual(SOURCE_DEFS.map((d) => d.key));
});

test("listRuns exposes business_only", () => {
  const { run_id } = requestRun(validateRunInput({ city: "Testville", business_only: true }));
  createdRuns.push(run_id);
  const row = listRuns().find((r) => r.run_id === run_id);
  expect(row).toBeDefined();
  expect(Number(row.business_only)).toBe(1);
});
