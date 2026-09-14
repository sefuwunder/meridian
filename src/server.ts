// meridian — graph OSINT recon server. Bun + zero deps, port 3005.
// Collectors live in sources.ts; this file runs recon jobs, persists the
// graph, and serves the API + static frontend.

import {
  createRecon, getRecon, listRecons, updateRecon, deleteRecon, fullRecon,
} from "./db";
import {
  SOURCE_DEFS, mergeGraph, addKeywordEdges, collectGeocode, collectOverpass, collectWikipedia,
  collectBusiness, collectPeople, collectMusic, collectNews,
  collectCountry, collectMoneyTime, collectWeather,
  type Ctx, type GNode, type GEdge, type SourceResult,
} from "./sources";

const PORT = Number(process.env.PORT || 3005);
const running = new Set<string>();

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

const COLLECTORS: Record<string, (ctx: Ctx) => Promise<SourceResult>> = {
  overpass: collectOverpass,
  wikipedia: collectWikipedia,
  business: collectBusiness,
  people: collectPeople,
  music: collectMusic,
  news: collectNews,
  country: collectCountry,
  moneytime: collectMoneyTime,
  weather: collectWeather,
};

function excludeTokensFor(city: string, country: string | null): string[] {
  return (city + " " + (country || "")).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}

// Interlink the graph: any two non-city nodes sharing a keyword get an edge.
// Recomputed from scratch each pass so labels stay current and never duplicate.
function interlink(nodes: GNode[], edges: GEdge[], city: string, country: string | null): GEdge[] {
  return addKeywordEdges(nodes, edges, { excludeTokens: excludeTokensFor(city, country) });
}

async function runRecon(id: string, city: string, wanted: string[]) {
  if (running.has(id)) return;
  running.add(id);
  const defs = SOURCE_DEFS.filter((d) => wanted.includes(d.key));
  const states = defs.map((d) => ({ key: d.key, label: d.label, state: "pending" as string, note: "", ms: 0 }));
  const setState = (key: string, patch: any) => {
    const s = states.find((x) => x.key === key);
    if (s) Object.assign(s, patch);
    updateRecon(id, { sources_json: JSON.stringify(states) });
  };
  const progress = (done: number, current: string) =>
    updateRecon(id, { progress_json: JSON.stringify({ done, total: defs.length, current }) });

  let nodes: GNode[] = [], edges: GEdge[] = [];
  const facts: Record<string, any> = {};
  const persist = () => updateRecon(id, {
    nodes_json: JSON.stringify(nodes), edges_json: JSON.stringify(edges),
    facts_json: JSON.stringify(facts),
  });

  try {
    progress(0, "geocoding");
    setState("geocode", { state: "running" });
    const t0 = Date.now();
    const { geo, result } = await collectGeocode(city);
    const ctx: Ctx = { city, ...geo, facts };
    ({ nodes, edges } = mergeGraph({ nodes, edges }, result));
    edges = interlink(nodes, edges, city, geo.country);
    updateRecon(id, {
      lat: geo.lat, lon: geo.lon, country: geo.country, country_code: geo.countryCode,
    });
    persist();
    setState("geocode", { state: "ok", note: result.note, ms: Date.now() - t0 });
    progress(1, "");

    let done = 1;
    for (const d of defs) {
      if (d.key === "geocode") continue;
      const fn = COLLECTORS[d.key];
      if (!fn) continue;
      setState(d.key, { state: "running" });
      progress(done, d.label);
      const t = Date.now();
      try {
        const r = await fn(ctx);
        ({ nodes, edges } = mergeGraph({ nodes, edges }, r));
        edges = interlink(nodes, edges, city, ctx.country);
        persist();
        setState(d.key, { state: "ok", note: r.note || "", ms: Date.now() - t });
      } catch (e: any) {
        setState(d.key, { state: "failed", note: String(e?.message || e).slice(0, 140), ms: Date.now() - t });
      }
      done++;
      progress(done, "");
    }
    const failed = states.filter((s) => s.state === "failed").length;
    updateRecon(id, { status: failed === 0 ? "ready" : failed === states.length ? "failed" : "partial" });
  } catch (e: any) {
    setState("geocode", { state: "failed", note: String(e?.message || e).slice(0, 140) });
    updateRecon(id, { status: "failed" });
  } finally {
    running.delete(id);
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    try {
      // ---------- recons ----------
      if (path === "/api/recon" && method === "GET") return json({ recons: listRecons() });
      if (path === "/api/recon" && method === "POST") {
        const b = await readBody(req);
        const city = String(b.city || "").trim();
        if (!city) return json({ error: "city is required" }, 400);
        const wanted: string[] = Array.isArray(b.sources) && b.sources.length
          ? b.sources.filter((k: string) => SOURCE_DEFS.some((d) => d.key === k))
          : SOURCE_DEFS.map((d) => d.key);
        if (!wanted.includes("geocode")) wanted.unshift("geocode");
        const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const states = SOURCE_DEFS.filter((d) => wanted.includes(d.key))
          .map((d) => ({ key: d.key, label: d.label, state: "pending", note: "", ms: 0 }));
        createRecon(id, city, states);
        runRecon(id, city, wanted); // background
        return json({ id }, 201);
      }
      const expMatch = path.match(/^\/api\/recon\/([^/]+)\/export$/);
      if (expMatch && method === "GET") {
        const row = getRecon(expMatch[1]);
        if (!row) return json({ error: "not found" }, 404);
        const f = fullRecon(row);
        return new Response(JSON.stringify({ city: f.city, country: f.country, facts: f.facts, nodes: f.nodes, edges: f.edges }, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="meridian-${f.city.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json"`,
          },
        });
      }
      const noteMatch = path.match(/^\/api\/recon\/([^/]+)\/notes$/);
      if (noteMatch && method === "POST") {
        const row = getRecon(noteMatch[1]);
        if (!row) return json({ error: "not found" }, 404);
        const b = await readBody(req);
        if (!String(b.label || "").trim()) return json({ error: "label is required" }, 400);
        const f = fullRecon(row);
        const nid = `note:${Date.now().toString(36)}`;
        const node: GNode = {
          id: nid, label: String(b.label).trim().slice(0, 120), type: "note",
          source: "analyst", detail: String(b.body || "").slice(0, 2000),
        };
        const target = f.nodes.some((n: GNode) => n.id === b.link_to) ? b.link_to : f.nodes[0]?.id;
        const merged = mergeGraph({ nodes: f.nodes, edges: f.edges }, {
          nodes: [node],
          edges: target ? [{ from: nid, to: target, label: "annotates" }] : [],
        });
        merged.edges = interlink(merged.nodes, merged.edges, f.city, f.country);
        updateRecon(row.id, { nodes_json: JSON.stringify(merged.nodes), edges_json: JSON.stringify(merged.edges) });
        return json({ node }, 201);
      }
      const rMatch = path.match(/^\/api\/recon\/([^/]+)$/);
      if (rMatch) {
        const row = getRecon(rMatch[1]);
        if (!row) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ recon: fullRecon(row) });
        if (method === "DELETE") { deleteRecon(rMatch[1]); return json({ ok: true }); }
      }

      // ---------- static ----------
      const filePath = "public" + (path === "/" ? "/index.html" : path);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": contentType(filePath) } });
      }
      if (!path.startsWith("/api/")) {
        return new Response(Bun.file("public/index.html"), { headers: { "Content-Type": "text/html" } });
      }
      return json({ error: "not found" }, 404);
    } catch (e: any) {
      return json({ error: e?.message || "server error" }, 500);
    }
  },
});

function contentType(p: string): string {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".js")) return "text/javascript";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

console.log(`meridian listening on http://localhost:${server.port}`);
