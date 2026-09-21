// meridian — graph OSINT recon server. Bun + zero deps, port 3005.
// Collectors live in sources.ts; this file runs recon jobs, persists the
// graph, and serves the API + static frontend.

import {
  createRecon, getRecon, listRecons, updateRecon, deleteRecon, fullRecon,
  createEnrichJob, getEnrichJob, listEnrichJobs, updateEnrichJob, fullEnrichJob,
  createProspectJob, getProspectJob, listProspectJobs, updateProspectJob, fullProspectJob,
} from "./db";
import { resolveDomain, enrichCompanySite } from "./enrich";
import { runProspect } from "./prospect";
import {
  initRouter, setRouterBase, requestRun, validateRunInput, listRuns, runDetail,
  applyBusinessOnly,
} from "./router";
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
  collectGleifName, collectSecEdgar, collectWikidataOrg,
  collectHkcr, collectEnhetsregisteret, collectExa, collectEnrich,
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
  gleifname: collectGleifName,
  secedgar: collectSecEdgar,
  wikidataorg: collectWikidataOrg,
  hkcr: collectHkcr,
  enhetsregisteret: collectEnhetsregisteret,
  exa: collectExa,
  enrich: collectEnrich,
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

async function runEnrichJob(id: string, query: string) {
  const key = "enrich:" + id;
  if (running.has(key)) return;
  running.add(key);
  const setProgress = (done: number, total: number, current: string) =>
    updateEnrichJob(id, { progress_json: JSON.stringify({ done, total, current }) });
  try {
    setProgress(0, 4, "resolving domain");
    const resolved = await resolveDomain(query);
    if (!resolved) {
      updateEnrichJob(id, {
        status: "failed",
        error: `couldn't resolve a company website for "${query}"`,
      });
      return;
    }
    const domain = resolved.domain;
    const scraped = await enrichCompanySite(domain, {
      progress: (_d, _t, c) =>
        setProgress(1, 4, c ? `scraping ${c}` : "scraping company pages"),
    });
    setProgress(2, 4, "querying registries");
    // fold in the keyless registries with a synthetic ctx: the "city" is the
    // company itself, so name-match edges point at the company node and the
    // conventional urlscan:domain:<slug> id lands on the scraped domain node.
    const companyId =
      scraped.nodes.find((n) => n.id.startsWith("enrich:company:"))?.id ||
      `enrich:company:${domain}`;
    const sub: Ctx = {
      city: query, lat: 0, lon: 0, bbox: { s: 0, w: 0, n: 0, e: 0 },
      country: "", countryCode: "", state: null, cityId: companyId,
      facts: { domains: [domain] },
    };
    let nodes = scraped.nodes, edges = scraped.edges;
    for (const fn of [collectGleifName, collectSecEdgar, collectWikidataOrg]) {
      try {
        const r = await fn(sub);
        ({ nodes, edges } = mergeGraph({ nodes, edges }, r));
      } catch { /* best-effort: one dead registry never fails the job */ }
    }
    setProgress(3, 4, "finalizing");
    updateEnrichJob(id, {
      status: "done",
      progress_json: JSON.stringify({ done: 4, total: 4, current: "" }),
      result_json: JSON.stringify(scraped.result),
      nodes_json: JSON.stringify(nodes),
      edges_json: JSON.stringify(edges),
    });
  } catch (e: any) {
    updateEnrichJob(id, { status: "failed", error: String(e?.message || e).slice(0, 200) });
  } finally {
    running.delete(key);
  }
}

export async function runProspectJob(id: string, location: string, industry: string) {
  const key = "prospect:" + id;
  if (running.has(key)) return;
  running.add(key);
  const setProgress = (done: number, total: number, current: string) =>
    updateProspectJob(id, { progress_json: JSON.stringify({ done, total, current }) });
  try {
    setProgress(0, 3, "geocoding");
    const { companies, nodes, edges } = await runProspect(location, industry, {
      progress: (d, t, c) => setProgress(d, t, c),
      // the territory node (and later the companies) stream into the store
      // as they arrive, so a job that dies downstream still shows something
      onPartial: (n, e) => updateProspectJob(id, {
        nodes_json: JSON.stringify(n), edges_json: JSON.stringify(e),
      }),
    });
    updateProspectJob(id, {
      status: "done",
      progress_json: JSON.stringify({ done: 3, total: 3, current: "" }),
      result_json: JSON.stringify({ companies }),
      nodes_json: JSON.stringify(nodes),
      edges_json: JSON.stringify(edges),
    });
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 200);
    if (/location not found/i.test(msg)) {
      // nothing to fall back to without a territory: a clean failure
      updateProspectJob(id, { status: "failed", error: msg });
    } else {
      // one dead downstream step never kills the whole job: keep whatever
      // was persisted (at least the territory node) and land in partial
      updateProspectJob(id, { status: "partial", error: msg });
    }
  } finally {
    running.delete(key);
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
      // ---------- source defs (drives the launch-form checkboxes; never hardcode) ----------
      if (path === "/api/source-defs" && method === "GET")
        return json({ sources: SOURCE_DEFS.map((d) => ({ key: d.key, label: d.label, business: d.business })) });
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

      // ---------- run router (outside consumers: milton, etc.) ----------
      // A "run" is a recon plus router metadata. Runs execute one at a
      // time, FIFO; on completion a callback POST fires if one was given.
      // No auth — for trusted local consumers only.
      if (path === "/api/runs" && method === "POST") {
        let v;
        try { v = validateRunInput(await readBody(req)); }
        catch (e: any) { return json({ error: String(e?.message || e).slice(0, 200) }, 400); }
        setRouterBase(new URL(req.url).origin);
        return json(requestRun(v), 202);
      }
      if (path === "/api/runs" && method === "GET") return json({ runs: listRuns() });
      const runMatch = path.match(/^\/api\/runs\/([A-Za-z0-9_-]+)$/);
      if (runMatch && method === "GET") {
        const d = runDetail(runMatch[1], new URL(req.url).origin);
        if (!d) return json({ error: "not found" }, 404);
        return json({ run: d });
      }

      // ---------- enrichment jobs ----------
      // Long-running company enrichment (own-site scrape + registry fold-in).
      // POST returns immediately with a job id; the job runs in the
      // background and the client polls GET /api/enrich/:id. Scraping is
      // explicitly allowed to take longer than a few seconds (capped at 60s).
      if (path === "/api/enrich" && method === "POST") {
        const b = await readBody(req);
        const query = String(b.query || "").trim().slice(0, 200);
        if (!query) return json({ error: "query is required" }, 400);
        const id = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        createEnrichJob(id, query);
        runEnrichJob(id, query); // background — never awaited
        return json({ job_id: id, status: "running" }, 201);
      }
      if (path === "/api/enrich" && method === "GET")
        return json({ jobs: listEnrichJobs() });
      const enrichMatch = path.match(/^\/api\/enrich\/([A-Za-z0-9_-]+)$/);
      if (enrichMatch && method === "GET") {
        const job = getEnrichJob(enrichMatch[1]);
        if (!job) return json({ error: "not found" }, 404);
        return json(fullEnrichJob(job));
      }

      // ---------- territory prospecting jobs ----------
      // Find companies by location + industry (a salesperson building a book
      // of business). POST returns immediately with a job id; the job runs
      // in the background and the client polls GET /api/prospect/:id. The
      // industry→OSM-tag match is deterministic; only the Nominatim geocode
      // and the one Overpass query touch the network, both timeout-guarded.
      if (path === "/api/prospect" && method === "POST") {
        const b = await readBody(req);
        const loc = String(b.location ?? ""), ind = String(b.industry ?? "");
        if (!loc.trim() || !ind.trim() || loc.length > 200 || ind.length > 200)
          return json({ error: "location and industry are required (max 200 chars each)" }, 400);
        const id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        createProspectJob(id, loc.trim(), ind.trim());
        runProspectJob(id, loc.trim(), ind.trim()); // background — never awaited
        return json({ job_id: id, status: "running" }, 201);
      }
      if (path === "/api/prospect" && method === "GET")
        return json({ jobs: listProspectJobs() });
      const prospectMatch = path.match(/^\/api\/prospect\/([A-Za-z0-9_-]+)$/);
      if (prospectMatch && method === "GET") {
        const job = getProspectJob(prospectMatch[1]);
        if (!job) return json({ error: "not found" }, 404);
        return json(fullProspectJob(job));
      }

      // ---------- recons ----------
      if (path === "/api/recon" && method === "GET") return json({ recons: listRecons() });
      if (path === "/api/recon" && method === "POST") {
        const b = await readBody(req);
        const city = String(b.city || "").trim();
        if (!city) return json({ error: "city is required" }, 400);
        let wanted: string[] = Array.isArray(b.sources) && b.sources.length
          ? b.sources.filter((k: string) => SOURCE_DEFS.some((d) => d.key === k))
          : SOURCE_DEFS.map((d) => d.key);
        if (b.business_only === true) {
          wanted = applyBusinessOnly(wanted);
          if (!wanted.some((k) => k !== "geocode"))
            return json({ error: "business_only: none of the requested sources emit business data" }, 400);
        }
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

// Run-request router: outside consumers (milton, ...) request recon runs
// here. Stale runs from a previous process are re-queued, never dropped.
initRouter({
  starter: (reconId, city, wanted) => runRecon(reconId, city, wanted),
  base: `http://localhost:${PORT}`,
});
