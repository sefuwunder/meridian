// meridian — graph OSINT recon server. Bun + zero deps, port 3005.
// Collectors live in sources.ts; this file runs recon jobs, persists the
// graph, and serves the API + static frontend.

import {
  createRecon, getRecon, listRecons, updateRecon, deleteRecon, fullRecon,
} from "./db";
import {
  SOURCE_DEFS, mergeGraph, addKeywordEdges, cityExcludeTokens, deepSearchNode,
  collectGeocode, collectOverpass, collectWikipedia,
  collectBusiness, collectPeople, collectMusic, collectNews,
  collectCountry, collectMoneyTime, collectWeather,
  collectGdelt, collectGleif, collectOpensky, collectOpenalex,
  collectGdacs, collectChronicling,
  collectIcig, collectOccrp, collectUrlscan, collectNonprofits, collectOpenfec,
  collectIpquery, collectFdic, collectArquivo, collectWigle,
  collectInternetdb, collectAdsblol, collectEonet, collectUsgs,
  collectHackertarget, collectMnemonic, collectCertspotter, collectBrasilapi,
  probeKeySource,
  type Ctx, type GNode, type GEdge, type SourceResult,
} from "./sources";
import {
  KEY_DEFS, keyStatuses, storeKey, clearStoredKey, resolveKey,
} from "./keys";
import { mergeNodes, mergeCaseInto } from "./graph";
import { listCases, getCase, saveCase, deleteCase } from "./cases";

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
  gdelt: collectGdelt,
  gleif: collectGleif,
  opensky: collectOpensky,
  openalex: collectOpenalex,
  gdacs: collectGdacs,
  chronicling: collectChronicling,
  icij: collectIcig,
  occrp: collectOccrp,
  urlscan: collectUrlscan,
  ipquery: collectIpquery,
  nonprofits: collectNonprofits,
  openfec: collectOpenfec,
  fdic: collectFdic,
  arquivo: collectArquivo,
  wigle: collectWigle,
  internetdb: collectInternetdb,
  adsblol: collectAdsblol,
  eonet: collectEonet,
  usgs: collectUsgs,
  hackertarget: collectHackertarget,
  mnemonic: collectMnemonic,
  certspotter: collectCertspotter,
  brasilapi: collectBrasilapi,
};

// Interlink the graph: any two non-city nodes sharing a keyword get an edge.
// Recomputed from scratch each pass so labels stay current and never duplicate.
// City/country tokens use the same exclusion list as deep search.
function interlink(nodes: GNode[], edges: GEdge[], city: string, country: string | null): GEdge[] {
  return addKeywordEdges(nodes, edges, { excludeTokens: cityExcludeTokens(city, country) });
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
      // ---------- api keys ----------
      if (path === "/api/keys" && method === "GET") return json({ keys: keyStatuses() });
      if (path === "/api/keys" && method === "POST") {
        const b = await readBody(req);
        const id = String(b.key || "");
        const def = KEY_DEFS.find((d) => d.id === id);
        if (!def) return json({ error: "unknown key" }, 400);
        const value = String(b.value || "").trim();
        if (!value) return json({ error: "value is required" }, 400);
        if (value.length > 500) return json({ error: "value too long" }, 400);
        storeKey(id, value);
        return json({ keys: keyStatuses() });
      }
      const keyDelMatch = path.match(/^\/api\/keys\/([A-Za-z0-9_]+)$/);
      if (keyDelMatch && method === "DELETE") {
        const id = keyDelMatch[1];
        if (!KEY_DEFS.some((d) => d.id === id)) return json({ error: "unknown key" }, 400);
        clearStoredKey(id);
        return json({ keys: keyStatuses() });
      }
      if (path === "/api/keys/test" && method === "POST") {
        const b = await readBody(req);
        const id = String(b.key || "");
        if (!KEY_DEFS.some((d) => d.id === id)) return json({ error: "unknown key" }, 400);
        const key = resolveKey(id);
        if (!key) return json({ error: "no key configured" }, 400);
        try {
          const probe = await probeKeySource(id, key);
          return json({ ok: true, detail: probe.detail });
        } catch (e: any) {
          return json({ ok: false, error: String(e?.message || e).slice(0, 140) }, 200);
        }
      }

      // ---------- case files ----------
      // Cases are the durable layer for analysis work: a named snapshot of
      // the working graph (nodes, edges, analyst notes, groups, dossier,
      // per-source states). They live in data/cases/ (gitignored, mode 0600)
      // — recon data is never committed.
      if (path === "/api/cases" && method === "GET") return json({ cases: listCases() });
      if (path === "/api/cases" && method === "POST") {
        const b = await readBody(req);
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "name is required" }, 400);
        if (name.length > 120) return json({ error: "name too long" }, 400);
        const s = b.snapshot || {};
        if (!Array.isArray(s.nodes) || !Array.isArray(s.edges))
          return json({ error: "snapshot.nodes/edges are required" }, 400);
        if (s.nodes.length > 50000 || s.edges.length > 200000)
          return json({ error: "snapshot too large" }, 400);
        const c = saveCase(name, {
          city: String(s.city || ""),
          country: s.country ?? null,
          country_code: s.country_code ?? null,
          lat: s.lat ?? null, lon: s.lon ?? null,
          cityId: String(s.cityId || ""),
          facts: s.facts && typeof s.facts === "object" ? s.facts : {},
          sources: Array.isArray(s.sources) ? s.sources : [],
          nodes: s.nodes, edges: s.edges,
          groups: Array.isArray(s.groups) ? s.groups : [],
        });
        return json({ id: c.id }, 201);
      }
      const caseMatch = path.match(/^\/api\/cases\/([A-Za-z0-9_-]+)$/);
      if (caseMatch) {
        const c = getCase(caseMatch[1]);
        if (!c) return json({ error: "not found" }, 404);
        if (method === "GET") return json({ case: c });
        if (method === "DELETE") { deleteCase(caseMatch[1]); return json({ ok: true }); }
      }

      // ---------- graph analysis ----------
      // merge-nodes, merge (case into graph), interlink, and deep-search all
      // operate on an explicit client-supplied graph so they work on recons
      // and opened cases alike. Keyword interlinks are recomputed with the
      // same extractor the collectors use.
      const graphBody = async () => {
        const b = await readBody(req);
        if (!Array.isArray(b.nodes) || !Array.isArray(b.edges))
          throw new Error("nodes and edges are required");
        return b;
      };
      if (path === "/api/graph/merge-nodes" && method === "POST") {
        try {
          const b = await graphBody();
          if (!Array.isArray(b.ids)) return json({ error: "ids are required" }, 400);
          const r = mergeNodes(b.nodes, b.edges, b.ids.map(String));
          const edges = interlink(r.nodes, r.edges, String(b.city || ""), b.country ?? null);
          return json({ nodes: r.nodes, edges, merged: r.merged, absorbed: r.absorbed });
        } catch (e: any) {
          return json({ error: String(e?.message || e).slice(0, 200) }, 400);
        }
      }
      if (path === "/api/graph/merge" && method === "POST") {
        try {
          const b = await graphBody();
          if (!b.add || !Array.isArray(b.add.nodes) || !Array.isArray(b.add.edges))
            return json({ error: "add.{nodes,edges} are required" }, 400);
          const beforeIds = new Set(b.nodes.map((n: GNode) => n.id));
          const ekey = (e: GEdge) => `${e.from}>${e.to}:${e.label}`;
          const beforeEdges = new Set(b.edges.map(ekey));
          let { nodes, edges } = mergeCaseInto(
            { nodes: b.nodes, edges: b.edges },
            { nodes: b.add.nodes, edges: b.add.edges }
          );
          edges = interlink(nodes, edges, String(b.city || ""), b.country ?? null);
          return json({
            nodes, edges,
            addedNodes: nodes.filter((n) => !beforeIds.has(n.id)).length,
            addedEdges: edges.filter((e) => !beforeEdges.has(ekey(e))).length,
          });
        } catch (e: any) {
          return json({ error: String(e?.message || e).slice(0, 200) }, 400);
        }
      }
      if (path === "/api/graph/interlink" && method === "POST") {
        try {
          const b = await graphBody();
          return json({ edges: interlink(b.nodes, b.edges, String(b.city || ""), b.country ?? null) });
        } catch (e: any) {
          return json({ error: String(e?.message || e).slice(0, 200) }, 400);
        }
      }
      if (path === "/api/graph/deep-search" && method === "POST") {
        let b: any;
        try { b = await graphBody(); }
        catch (e: any) { return json({ error: String(e?.message || e).slice(0, 200) }, 400); }
        const nodeId = String(b.nodeId || "");
        if (!nodeId) return json({ error: "nodeId is required" }, 400);
        const target = b.nodes.find((n: GNode) => n.id === nodeId);
        if (!target) return json({ error: "node not found" }, 404);
        const beforeIds = new Set(b.nodes.map((n: GNode) => n.id));
        const ekey = (e: GEdge) => `${e.from}>${e.to}:${e.label}`;
        const beforeEdges = new Set(b.edges.map(ekey));
        const ds = await deepSearchNode(target, b.nodes, { city: String(b.city || ""), country: b.country ?? null });
        let { nodes, edges } = mergeGraph({ nodes: b.nodes, edges: b.edges }, ds);
        edges = interlink(nodes, edges, String(b.city || ""), b.country ?? null);
        const flagged = nodes.find((n) => n.id === nodeId);
        if (flagged) flagged.deepSearched = true;
        return json({
          nodes, edges,
          addedNodes: nodes.filter((n) => !beforeIds.has(n.id)).length,
          addedEdges: edges.filter((e) => !beforeEdges.has(ekey(e))).length,
          keywords: ds.keywords,
        });
      }

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
      const dsMatch = path.match(/^\/api\/recon\/([^/]+)\/deep-search$/);
      if (dsMatch && method === "POST") {
        const row = getRecon(dsMatch[1]);
        if (!row) return json({ error: "not found" }, 404);
        const b = await readBody(req);
        const nodeId = String(b.nodeId || "");
        if (!nodeId) return json({ error: "nodeId is required" }, 400);
        const f = fullRecon(row);
        const target = f.nodes.find((n: GNode) => n.id === nodeId);
        if (!target) return json({ error: "node not found" }, 404);
        // same merge path as analyst notes: merge + keyword-edge recomputation
        const beforeIds = new Set(f.nodes.map((n: GNode) => n.id));
        const ekey = (e: GEdge) => `${e.from}>${e.to}:${e.label}`;
        const beforeEdges = new Set(f.edges.map(ekey));
        const ds = await deepSearchNode(target, f.nodes, { city: f.city, country: f.country });
        let { nodes, edges } = mergeGraph({ nodes: f.nodes, edges: f.edges }, ds);
        edges = interlink(nodes, edges, f.city, f.country);
        const flagged = nodes.find((n) => n.id === nodeId);
        if (flagged) flagged.deepSearched = true;
        updateRecon(row.id, { nodes_json: JSON.stringify(nodes), edges_json: JSON.stringify(edges) });
        return json({
          addedNodes: nodes.filter((n) => !beforeIds.has(n.id)).length,
          addedEdges: edges.filter((e) => !beforeEdges.has(ekey(e))).length,
          keywords: ds.keywords,
        });
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
