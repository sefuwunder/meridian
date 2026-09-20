// meridian — tests for territory prospecting (39) and the /api/prospect job
// machinery. All network is stubbed; nothing here touches the real web.
// The suite shares the dev API server with enrich.test.ts on scratch port
// 45691: whichever file's dynamic server import runs first binds it, and
// the other file's cached import reuses it — verified from a fresh clone
// in both readdir orders before pushing.
import { test, expect, beforeAll, afterEach } from "bun:test";
import {
  INDUSTRY_TAGS, matchIndustry, singularish, escapeRegex, formatAddress,
  buildOverpassQuery, geocodeLocation, runProspect, PROSPECT_UA,
} from "./prospect";
import {
  createProspectJob, getProspectJob, listProspectJobs, updateProspectJob, fullProspectJob,
  db,
} from "./db";
import { readFileSync } from "fs";

const realFetch = globalThis.fetch as any;

// ---------- canned web ----------

const NOMINATIM_JSON = [{
  lat: "39.1566", lon: "-84.3691",
  display_name: "Madisonville, Cincinnati, Hamilton County, Ohio, United States",
  address: { country: "United States", country_code: "us" },
}];

const OVERPASS_JSON = {
  elements: [
    {
      type: "node", id: 101, lat: 39.157, lon: -84.370,
      tags: {
        name: "Bright Smile Dental", amenity: "dentist",
        "addr:housenumber": "4821", "addr:street": "Madison Rd",
        "addr:city": "Cincinnati", "addr:state": "OH", "addr:postcode": "45227",
      },
    },
    {
      type: "way", id: 102, center: { lat: 39.158, lon: -84.371 },
      tags: { name: "Gentle Care Dental", amenity: "dentist" },
    },
    { type: "node", id: 103, lat: 39.159, lon: -84.372, tags: { amenity: "dentist" } }, // nameless — skipped
    {
      type: "node", id: 104, lat: 39.16, lon: -84.373,
      tags: { name: "Bright Smile Dental", amenity: "dentist" }, // duplicate name — skipped
    },
    { type: "way", id: 105, tags: { name: "No Coords Dental", amenity: "dentist" } }, // no coords — skipped
  ],
};

function jsonResponse(body: any): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

/** Canned network for unit tests: Nominatim + Overpass only. */
function stubFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.includes("nominatim.openstreetmap.org")) {
    return Promise.resolve(jsonResponse(u.includes("Nowhere") ? [] : NOMINATIM_JSON));
  }
  if (u.includes("overpass-api.de")) return Promise.resolve(jsonResponse(OVERPASS_JSON));
  return Promise.resolve(new Response("not found", { status: 404 }));
}

// The prospect tables come from the shared db module; make sure this file's
// own stores exist even when it runs first (hostile readdir order).
beforeAll(() => {
  db.exec(`SELECT count(*) FROM prospect_jobs`);
});

// ---------- industry matching ----------

test("matchIndustry maps curated industries to OSM tags", () => {
  expect(matchIndustry("dental")).toEqual(["amenity=dentist"]);
  expect(matchIndustry("restaurants")).toEqual(["amenity=restaurant", "amenity=fast_food"]);
  expect(matchIndustry("law")).toEqual(["office=lawyer"]);
  expect(matchIndustry("gas stations")).toEqual(["amenity=fuel"]);
  expect(matchIndustry("Plumbers")).toEqual(["craft=plumber"]);
  expect(matchIndustry("software")).toEqual(["office=it"]);
  expect(matchIndustry("car dealers")).toEqual(["shop=car"]);
  expect(matchIndustry("churches")).toEqual(["amenity=place_of_worship"]);
});

test("matchIndustry resolves aliases and trailing phrases", () => {
  expect(matchIndustry("Dental Clinics")).toEqual(["amenity=dentist"]);
  expect(matchIndustry("LAW FIRMS")).toEqual(["office=lawyer"]);
  expect(matchIndustry("attorneys")).toEqual(["office=lawyer"]);
  expect(matchIndustry("barber shops")).toEqual(["shop=hairdresser", "shop=beauty"]);
  expect(matchIndustry("grocery stores")).toEqual(["shop=supermarket", "shop=convenience"]);
  expect(matchIndustry("marketing")).toEqual(["office=advertising_agency"]);
  expect(matchIndustry("specialty dental clinic")).toEqual(["amenity=dentist"]);
});

test("matchIndustry returns null for uncovered industries", () => {
  expect(matchIndustry("boba tea")).toBeNull();
  expect(matchIndustry("left-handed widgets")).toBeNull();
  expect(matchIndustry("   ")).toBeNull();
});

test("INDUSTRY_TAGS covers the expected breadth", () => {
  expect(Object.keys(INDUSTRY_TAGS).length).toBeGreaterThanOrEqual(25);
  for (const sels of Object.values(INDUSTRY_TAGS))
    for (const s of sels) expect(s).toMatch(/^[\w:]+=[\w_]+$/);
});

test("singularish strips plurals without mangling words", () => {
  expect(singularish("restaurants")).toBe("restaurant");
  expect(singularish("churches")).toBe("church");
  expect(singularish("bakeries")).toBe("bakery");
  expect(singularish("glass")).toBe("glass");
  expect(singularish("class")).toBe("class");
  expect(singularish("bus")).toBe("bus");
});

// ---------- Overpass query builder ----------

const BBOX = { s: 39.0, w: -84.5, n: 39.2, e: -84.3 };

test("buildOverpassQuery is bounded with a timeout directive", () => {
  const q = buildOverpassQuery(BBOX, { kind: "tags", selectors: ["amenity=dentist"] });
  expect(q).toContain("[out:json][timeout:40]");
  expect(q).toContain('nwr["amenity"="dentist"](39,-84.5,39.2,-84.3);');
  expect(q).toContain("out center 100;");
});

test("buildOverpassQuery ORs multiple selectors", () => {
  const q = buildOverpassQuery(BBOX, {
    kind: "tags", selectors: ["shop=hairdresser", "shop=beauty"],
  });
  expect(q).toContain('nwr["shop"="hairdresser"]');
  expect(q).toContain('nwr["shop"="beauty"]');
});

test("buildOverpassQuery escapes the fallback keyword", () => {
  const q = buildOverpassQuery(BBOX, { kind: "name", keyword: "c++ (tutoring)" });
  expect(q).toContain('nwr["name"~"c\\+\\+ \\(tutoring\\)",i]');
  expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
});

// ---------- geocode ----------

test("geocodeLocation returns lat/lon, bbox, and display name", async () => {
  const geo = await geocodeLocation("Madisonville, Cincinnati", stubFetch as any);
  expect(geo.lat).toBeCloseTo(39.1566, 4);
  expect(geo.lon).toBeCloseTo(-84.3691, 4);
  expect(geo.display_name).toContain("Madisonville");
  expect(geo.bbox.s).toBeCloseTo(geo.lat - 0.12, 6);
  expect(geo.bbox.n).toBeCloseTo(geo.lat + 0.12, 6);
});

test("geocodeLocation miss throws a clear error", async () => {
  const err = await geocodeLocation("Nowhere Xyzzy", stubFetch as any).then(
    () => null, (e) => e);
  expect(err).toBeTruthy();
  expect(String(err.message)).toMatch(/location not found: Nowhere Xyzzy/);
});

test("geocodeLocation uses the prospecting UA", async () => {
  let seen = "";
  const spy = (url: string, init?: RequestInit) => {
    seen = String((init?.headers as any)?.["User-Agent"] || "");
    return stubFetch(url, init);
  };
  await geocodeLocation("Madisonville, Cincinnati", spy as any);
  expect(seen).toBe(PROSPECT_UA);
  expect(seen).toContain("territory prospecting");
});

test("formatAddress joins addr:* parts", () => {
  expect(formatAddress({
    "addr:housenumber": "4821", "addr:street": "Madison Rd",
    "addr:city": "Cincinnati", "addr:state": "OH", "addr:postcode": "45227",
  })).toBe("4821 Madison Rd, Cincinnati OH 45227");
  expect(formatAddress({ "addr:street": "Main St" })).toBe("Main St");
  expect(formatAddress({})).toBe("");
});

// ---------- runProspect (stubbed network) ----------

test("runProspect builds companies, graph nodes, and territory edges", async () => {
  const steps: string[] = [];
  let partials = 0;
  const r = await runProspect("Madisonville, Cincinnati", "dental", {
    fetchImpl: stubFetch as any,
    progress: (_d, _t, c) => steps.push(c),
    onPartial: () => partials++,
  });
  // nameless, duplicate, and coord-less elements are dropped
  expect(r.companies.length).toBe(2);

  const c0 = r.companies[0];
  expect(c0.name).toBe("Bright Smile Dental");
  expect(c0.address).toBe("4821 Madison Rd, Cincinnati OH 45227");
  expect(c0.lat).toBeCloseTo(39.157, 4);
  expect(c0.industry).toBe("dental");
  expect(c0.territory).toBe("Madisonville, Cincinnati");
  expect(c0.source).toBe("overpass");
  expect(c0.prospect).toBe(true);
  expect(c0.tags["amenity"]).toBe("dentist");

  // node shape
  const n0 = r.nodes.find((n) => n.id === "prospect:bright-smile-dental-0")!;
  expect(n0).toBeTruthy();
  expect(n0.type).toBe("org");
  expect(n0.subtype).toBe("prospect");
  expect(n0.source).toBe("overpass");
  expect(n0.detail).toContain("dental · 4821 Madison Rd");
  expect(n0.url).toContain("openstreetmap.org");

  // territory node + edges
  const terr = r.nodes.find((n) => n.id.startsWith("prospect:territory:"))!;
  expect(terr).toBeTruthy();
  expect(terr.type).toBe("place");
  expect(terr.label).toBe("Madisonville, Cincinnati");
  expect(terr.lat).toBeCloseTo(39.1566, 4);
  expect(r.edges.length).toBe(2);
  for (const e of r.edges) {
    expect(e.to).toBe(terr.id);
    expect(e.label).toBe("located in");
  }

  expect(steps).toContain("geocoding");
  expect(steps).toContain("querying overpass");
  expect(partials).toBe(2); // after geocode and after the overpass parse
});

test("runProspect falls back to a name regex for unknown industries", async () => {
  let posted = "";
  const spy = (url: string, init?: RequestInit) => {
    if (String(url).includes("overpass-api.de")) {
      const b = String((init as any)?.body || "");
      posted = decodeURIComponent(b.replace(/^data=/, ""));
    }
    return stubFetch(url, init);
  };
  await runProspect("Madisonville, Cincinnati", "boba tea", { fetchImpl: spy as any });
  expect(posted).toContain('nwr["name"~"boba tea",i]');
});

test("runProspect caps companies at 100", async () => {
  const many = { elements: Array.from({ length: 140 }, (_, i) => ({
    type: "node", id: 1000 + i, lat: 39.1, lon: -84.3,
    tags: { name: `Dental Co ${i}`, amenity: "dentist" },
  })) };
  const big = (url: string, init?: RequestInit) =>
    String(url).includes("overpass-api.de")
      ? Promise.resolve(jsonResponse(many))
      : stubFetch(url, init);
  const r = await runProspect("Madisonville, Cincinnati", "dental", { fetchImpl: big as any });
  expect(r.companies.length).toBe(100);
  expect(r.nodes.filter((n) => n.subtype === "prospect").length).toBe(100);
});

// ---------- db ----------

test("prospect job db: create -> update -> full shape -> list", () => {
  const id = "ptest" + Date.now().toString(36);
  createProspectJob(id, "Madisonville, Cincinnati", "dental");
  expect(getProspectJob(id)!.status).toBe("running");
  updateProspectJob(id, { progress_json: JSON.stringify({ done: 1, total: 3, current: "geocoding" }) });
  const full = fullProspectJob(getProspectJob(id)!);
  expect(full.location).toBe("Madisonville, Cincinnati");
  expect(full.industry).toBe("dental");
  expect(full.progress.done).toBe(1);
  expect(full.companies).toEqual([]);
  expect(full.error).toBeNull();
  const listed = listProspectJobs().find((j: any) => j.id === id)!;
  expect(listed.company_count).toBe(0);
  updateProspectJob(id, {
    status: "done", result_json: JSON.stringify({ companies: [{ name: "X" }] }),
  });
  expect(listProspectJobs().find((j: any) => j.id === id)!.company_count).toBe(1);
  expect(fullProspectJob(getProspectJob(id)!).companies.length).toBe(1);
  db.query("DELETE FROM prospect_jobs WHERE id = ?").run(id);
});

// ---------- /api/prospect job lifecycle (live server, canned network) ----------

const API_PORT = 45691;
const API_BASE = `http://localhost:${API_PORT}`;

function lifecycleStub(url: string, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (/localhost:\d+|127\.0\.0\.1:\d+/.test(u)) return realFetch(url, init);
  if (u.includes("nominatim.openstreetmap.org"))
    return Promise.resolve(jsonResponse(u.includes("Nowhere") ? [] : NOMINATIM_JSON));
  if (u.includes("overpass-api.de")) return Promise.resolve(jsonResponse(OVERPASS_JSON));
  return realFetch(url, init);
}

let apiBooted = false;
async function bootApi() {
  globalThis.fetch = lifecycleStub as any;
  process.env.PORT = String(API_PORT);
  await import("./server"); // cached when enrich.test.ts got here first
  // wait for whichever scratch port won (hostile order)
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const r = await realFetch(`${API_BASE}/api/prospect`);
      if (r.ok) { apiBooted = true; return; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("scratch API server never came up");
    await new Promise((r2) => setTimeout(r2, 100));
  }
}

async function pollProspectJob(id: string, terminal: string[]): Promise<any> {
  const deadline = Date.now() + 25000;
  for (;;) {
    const r = await realFetch(`${API_BASE}/api/prospect/${id}`);
    const j: any = await r.json();
    if (terminal.includes(j.status)) return j;
    if (Date.now() > deadline) throw new Error(`prospect job ${id} stuck in "${j.status}"`);
    await new Promise((r2) => setTimeout(r2, 100));
  }
}

const lifecycleJobIds: string[] = [];

afterEach(() => {
  // keep the global fetch hygiene the rest of the suite expects
  if (apiBooted) globalThis.fetch = lifecycleStub as any;
});

test("POST /api/prospect runs running -> done with companies and graph", async () => {
  await bootApi();
  const post = await realFetch(`${API_BASE}/api/prospect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: "Madisonville, Cincinnati", industry: "dental" }),
  });
  expect(post.status).toBe(201);
  const created: any = await post.json();
  expect(created.status).toBe("running");
  expect(typeof created.job_id).toBe("string");
  lifecycleJobIds.push(created.job_id);

  const done = await pollProspectJob(created.job_id, ["done", "failed", "partial"]);
  expect(done.status).toBe("done");
  expect(done.progress.done).toBe(3);
  expect(done.companies.length).toBe(2);
  const c0 = done.companies[0];
  expect(c0.name).toBe("Bright Smile Dental");
  expect(c0.address).toBe("4821 Madison Rd, Cincinnati OH 45227");
  expect(c0.source).toBe("overpass");
  expect(c0.prospect).toBe(true);
  expect(c0.territory).toBe("Madisonville, Cincinnati");
  const ids = (done.nodes || []).map((n: any) => n.id);
  expect(ids.some((id: string) => id.startsWith("prospect:territory:"))).toBe(true);
  expect(ids).toContain("prospect:bright-smile-dental-0");
  expect(done.edges.every((e: any) => e.label === "located in")).toBe(true);

  const list: any = await realFetch(`${API_BASE}/api/prospect`).then((r: any) => r.json());
  const row = list.jobs.find((j: any) => j.id === created.job_id);
  expect(row).toBeTruthy();
  expect(row.company_count).toBe(2);
  expect(row.status).toBe("done");
}, 30000);

test("POST /api/prospect runs running -> failed on a location miss", async () => {
  await bootApi();
  const post = await realFetch(`${API_BASE}/api/prospect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ location: "Nowhere Xyzzy", industry: "dental" }),
  });
  expect(post.status).toBe(201);
  const created: any = await post.json();
  lifecycleJobIds.push(created.job_id);

  const failed = await pollProspectJob(created.job_id, ["done", "failed", "partial"]);
  expect(failed.status).toBe("failed");
  expect(String(failed.error)).toMatch(/location not found: Nowhere Xyzzy/);
}, 30000);

test("re-running a job id while it runs never duplicates nodes", async () => {
  await bootApi();
  const { runProspectJob } = await import("./server");
  const id = "prerun" + Date.now().toString(36);
  lifecycleJobIds.push(id);
  createProspectJob(id, "Madisonville, Cincinnati", "dental");
  await Promise.all([
    runProspectJob(id, "Madisonville, Cincinnati", "dental"),
    runProspectJob(id, "Madisonville, Cincinnati", "dental"),
  ]);
  const full = fullProspectJob(getProspectJob(id)!);
  expect(full.status).toBe("done");
  expect(full.companies.length).toBe(2);
  const ids = full.nodes.map((n: any) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("POST /api/prospect 400s on bad input; GET 404s unknown jobs", async () => {
  await bootApi();
  for (const body of [
    { location: "Madisonville", industry: "   " },
    { location: "", industry: "dental" },
    { location: "x".repeat(201), industry: "dental" },
    {},
  ]) {
    const bad = await realFetch(`${API_BASE}/api/prospect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(bad.status).toBe(400);
  }
  const missing = await realFetch(`${API_BASE}/api/prospect/pnope123`);
  expect(missing.status).toBe(404);
}, 30000);

// Remove the lifecycle jobs so the dev database stays clean, and leave the
// network stub installed for any file that booted the shared server after us.
test("lifecycle cleanup", async () => {
  for (const id of lifecycleJobIds)
    db.query("DELETE FROM prospect_jobs WHERE id = ?").run(id);
  expect(lifecycleJobIds.length).toBe(3);
});

// ---------- prospect panel UI (DOM-stubbed) ----------

function makeEl(tag: string): any {
  const el: any = {
    tag, children: [], _html: "", textContent: "", value: "", checked: false,
    disabled: false, style: {}, dataset: {}, hidden: false,
    _q: new Map<string, any>(),
    set innerHTML(v: string) { this._html = String(v); },
    get innerHTML() { return this._html; },
    appendChild(c: any) { this.children.push(c); return c; },
    append(...cs: any[]) { for (const c of cs) this.children.push(c); },
    querySelector(s: string) {
      if (!this._q.has(s)) this._q.set(s, makeEl("span"));
      return this._q.get(s);
    },
    querySelectorAll(_s: string) { return []; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }),
    click() {}, focus() {}, setAttribute() {}, getAttribute: () => null,
    getContext() {
      return new Proxy({}, {
        get: (_t, prop) => {
          if (prop === "canvas") return el;
          if (prop === "measureText") return () => ({ width: 10 });
          if (prop === "getImageData") return () => ({ data: [] });
          return () => {};
        },
        set: () => true,
      });
    },
    width: 800, height: 600,
  };
  return el;
}

test("prospect panel lists jobs with status pills", async () => {
  const byId = new Map<string, any>();
  const docStub: any = {
    readyState: "loading",
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, makeEl("div"));
      return byId.get(id);
    },
    createElement: (t: string) => makeEl(t),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const g: any = globalThis;
  const prevDoc = g.document, prevWin = g.window, prevFetch = g.fetch;
  g.document = docStub;
  g.window = g;
  g.fetch = async (url: string) => {
    if (String(url).includes("/api/prospect/p1"))
      return jsonResponse({
        id: "p1", location: "Madisonville, Cincinnati", industry: "dental",
        status: "done", progress: { done: 3, total: 3, current: "" }, error: null,
        companies: [{ name: "Bright Smile Dental" }],
        nodes: [{ id: "prospect:territory:madisonville", label: "Madisonville, Cincinnati", type: "place" }],
        edges: [], created_at: 1, updated_at: 2,
      });
    return jsonResponse({
      jobs: [
        { id: "p1", location: "Madisonville, Cincinnati", industry: "dental", status: "done", company_count: 2, created_at: 1, updated_at: 2 },
        { id: "p2", location: "Nowhere Xyzzy", industry: "dental", status: "running", company_count: 0, created_at: 1, updated_at: 2 },
      ],
    });
  };
  try {
    const src = readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
    (0, eval)(src);
    await g.__meridian.loadProspectList();
    const box = byId.get("prospectList");
    expect(box.children.length).toBe(2);
    const t0 = box.children[0].querySelector(".t span").textContent;
    expect(t0).toBe("dental · Madisonville, Cincinnati");
    expect(box.children[0].querySelector(".m").textContent).toContain("2 companies");
    const t1 = box.children[1].querySelector(".t span").textContent;
    expect(t1).toBe("dental · Nowhere Xyzzy");

    // clicking a finished job loads its graph into the canvas model
    box.children[0].onclick();
    await new Promise((r) => setTimeout(r, 50));
    expect(g.__meridian.S.recon.id).toBe("prospect:p1");
    expect(g.__meridian.S.recon.nodes.length).toBe(1);
  } finally {
    g.document = prevDoc; g.window = prevWin; g.fetch = prevFetch;
    delete g.__meridian;
  }
});
