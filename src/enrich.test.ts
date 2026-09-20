// meridian — tests for the company enrichment collector (39) and the
// /api/enrich job machinery. All network is stubbed; nothing here touches
// the real web.
import { test, expect, afterEach } from "bun:test";
import {
  domainFromQuery, parseDdgResults, resolveDomain,
  isScrapableUrl, sameSite, parseRobotsDisallow, pathAllowed,
  extractJsonLd, extractMetaProfile, extractPrincipals, validPrincipalName,
  enrichCompanySite,
} from "./enrich";
import { collectEnrich } from "./sources";
import { readFileSync } from "fs";

// ---------- canned web ----------

const DOMAIN = "acme.example.com";

const DDG_HTML = `
<html><body>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.example.com%2F&rut=abc">Acme Widgets</a>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flinkedin.com%2Fcompany%2Facme&rut=def">Acme on LinkedIn</a>
</body></html>`;

const HOME_HTML = `
<html><head><title>Acme Widgets Inc.</title>
<meta property="og:description" content="Acme Widgets makes fine widgets since 1998.">
<script type="application/ld+json">
{"@type":"Organization","name":"Acme Widgets Inc.","description":"Makers of fine widgets.",
 "foundingDate":"1998","numberOfEmployees":120,
 "employee":[{"name":"Ada Lovelace","jobTitle":"Chief Executive Officer"},
             {"name":"Grace Hopper","jobTitle":"CTO"}]}
</script></head>
<body>
<div class="team-member"><h3>Alan Turing</h3><p>Chief Operating Officer</p>
<a href="mailto:alan@acme.example.com">email</a></div>
<div class="team-card"><h3>Katherine Johnson</h3><p>VP of Engineering</p>
<a href="mailto:katherine@gmail.com">email</a></div>
</body></html>`;

const TEAM_HTML = `
<html><head><title>Leadership — Acme</title></head><body>
<div class="leadership-grid">
<div class="leader"><h2>Edsger Dijkstra</h2><span>Managing Director</span></div>
</div></body></html>`;

const ROBOTS = "User-agent: *\nDisallow: /contact\n";

const GLEIF_JSON = {
  data: [{
    id: "549300ABCDEF12345678",
    attributes: { entity: { legalName: { name: "ACME WIDGETS INC" }, status: "ACTIVE" } },
  }],
};

const EMPTY_EFTS = { hits: { hits: [] } };
const EMPTY_WD = { search: [] };

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status, headers: { "content-type": "text/html; charset=utf-8" },
  });
}
function jsonResponse(body: any): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

/** Stub fetch serving the canned Acme site + registries. */
function stubFetch(url: string, _init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.includes("html.duckduckgo.com")) return Promise.resolve(htmlResponse(DDG_HTML));
  if (u === `https://${DOMAIN}/robots.txt`) return Promise.resolve(htmlResponse(ROBOTS));
  if (u === `https://${DOMAIN}/`) return Promise.resolve(htmlResponse(HOME_HTML));
  if (u === `https://${DOMAIN}/team`) return Promise.resolve(htmlResponse(TEAM_HTML));
  if (u.includes("api.gleif.org")) return Promise.resolve(jsonResponse(GLEIF_JSON));
  if (u.includes("efts.sec.gov") || u.includes("data.sec.gov")) return Promise.resolve(jsonResponse(EMPTY_EFTS));
  if (u.includes("wikidata.org/w/api.php")) return Promise.resolve(jsonResponse(EMPTY_WD));
  return Promise.resolve(new Response("not found", { status: 404 }));
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// ---------- domain resolution ----------

test("domainFromQuery accepts bare domains and URLs", () => {
  expect(domainFromQuery("acme.com")).toBe("acme.com");
  expect(domainFromQuery("https://www.acme.com/about")).toBe("www.acme.com");
  expect(domainFromQuery("http://acme.co.uk/")).toBe("acme.co.uk");
});

test("domainFromQuery rejects company names", () => {
  expect(domainFromQuery("living foods")).toBeNull();
  expect(domainFromQuery("acme")).toBeNull();
  expect(domainFromQuery("")).toBeNull();
});

test("parseDdgResults decodes uddg links", () => {
  const urls = parseDdgResults(DDG_HTML);
  expect(urls).toContain("https://acme.example.com/");
  expect(urls).toContain("https://linkedin.com/company/acme");
});

test("resolveDomain resolves a company name via DDG and verifies the homepage", async () => {
  const r = await resolveDomain("acme widgets", stubFetch as any);
  expect(r).not.toBeNull();
  expect(r!.domain).toBe(DOMAIN);
  expect(r!.homepage).toBe(`https://${DOMAIN}/`);
});

test("resolveDomain takes a direct domain from the query", async () => {
  const r = await resolveDomain("acme.example.com", stubFetch as any);
  expect(r!.domain).toBe(DOMAIN);
});

test("resolveDomain fails cleanly when nothing resolves", async () => {
  const dead = () => Promise.resolve(new Response("nope", { status: 404 }));
  const r = await resolveDomain("no such company xyzzy", dead as any);
  expect(r).toBeNull();
});

// ---------- scraping boundaries ----------

test("isScrapableUrl whitelists the company domain only", () => {
  expect(isScrapableUrl(`https://${DOMAIN}/team`, DOMAIN)).toBe(true);
  expect(isScrapableUrl(`https://www.${DOMAIN}/about`, DOMAIN)).toBe(true);
  expect(isScrapableUrl("https://linkedin.com/company/acme", DOMAIN)).toBe(false);
  expect(isScrapableUrl("https://twitter.com/acme", DOMAIN)).toBe(false);
  expect(isScrapableUrl("https://evil.com/", DOMAIN)).toBe(false);
  expect(isScrapableUrl(`ftp://${DOMAIN}/x`, DOMAIN)).toBe(false);
});

test("sameSite allows subdomains, blocks lookalikes", () => {
  expect(sameSite("www.acme.example.com", DOMAIN)).toBe(true);
  expect(sameSite("acme.example.com.evil.com", DOMAIN)).toBe(false);
});

test("robots Disallow paths are skipped", () => {
  const d = parseRobotsDisallow(ROBOTS);
  expect(d).toEqual(["/contact"]);
  expect(pathAllowed("/contact", d)).toBe(false);
  expect(pathAllowed("/team", d)).toBe(true);
  expect(pathAllowed("/", d)).toBe(true);
});

// ---------- profile parsing ----------

test("extractJsonLd pulls org profile and staff", () => {
  const p = extractJsonLd(HOME_HTML);
  expect(p.name).toBe("Acme Widgets Inc.");
  expect(p.description).toContain("fine widgets");
  expect(p.founded).toBe("1998");
  expect(p.employees).toBe("120");
  expect(p.staff).toContainEqual({ name: "Ada Lovelace", title: "Chief Executive Officer" });
  expect(p.staff).toContainEqual({ name: "Grace Hopper", title: "CTO" });
});

test("extractMetaProfile reads og tags", () => {
  const p = extractMetaProfile(HOME_HTML);
  expect(p.title).toBe("Acme Widgets Inc.");
  expect(p.description).toContain("fine widgets");
});

// ---------- principal extraction ----------

test("validPrincipalName accepts real names, rejects junk", () => {
  expect(validPrincipalName("Ada Lovelace")).toBe(true);
  expect(validPrincipalName("Katherine Johnson")).toBe(true);
  expect(validPrincipalName("J. R. Smith")).toBe(true);
  expect(validPrincipalName("Acme")).toBe(false); // single token
  expect(validPrincipalName("Acme Widgets Inc")).toBe(false); // corp suffix
  expect(validPrincipalName("Chief Executive")).toBe(false); // title, not name
  expect(validPrincipalName("our team")).toBe(false); // lowercase
  expect(validPrincipalName("A".repeat(61))).toBe(false);
});

test("extractPrincipals finds heading pairs and team cards", () => {
  const ps = extractPrincipals(HOME_HTML, `https://${DOMAIN}/`, DOMAIN);
  const names = ps.map((p) => p.name);
  expect(names).toContain("Alan Turing");
  expect(names).toContain("Katherine Johnson");
  const alan = ps.find((p) => p.name === "Alan Turing")!;
  expect(alan.title).toMatch(/Chief Operating Officer/i);
  expect(alan.source_url).toBe(`https://${DOMAIN}/`);
  // company-domain email kept, gmail dropped
  expect(alan.email).toBe("alan@acme.example.com");
  const kj = ps.find((p) => p.name === "Katherine Johnson")!;
  expect(kj.email).toBeUndefined();
  // no duplicates from the two strategies
  expect(new Set(names).size).toBe(names.length);
});

test("extractPrincipals handles leadership pages", () => {
  const ps = extractPrincipals(TEAM_HTML, `https://${DOMAIN}/team`, DOMAIN);
  expect(ps.map((p) => p.name)).toContain("Edsger Dijkstra");
  expect(ps.find((p) => p.name === "Edsger Dijkstra")!.title).toMatch(/Managing Director/i);
});

test("extractPrincipals rejects off-domain and social source URLs", () => {
  expect(extractPrincipals(HOME_HTML, "https://linkedin.com/company/acme", DOMAIN)).toEqual([]);
  expect(extractPrincipals(HOME_HTML, "https://twitter.com/acme", DOMAIN)).toEqual([]);
  expect(extractPrincipals(HOME_HTML, "https://evil.com/team", DOMAIN)).toEqual([]);
  expect(extractPrincipals(HOME_HTML, "", DOMAIN)).toEqual([]);
  // on-domain still works
  expect(extractPrincipals(HOME_HTML, `https://${DOMAIN}/`, DOMAIN).length).toBeGreaterThan(0);
});

// ---------- full scrape ----------

test("enrichCompanySite builds profile, principals, and graph", async () => {
  const { result, nodes, edges } = await enrichCompanySite(DOMAIN, {
    fetchImpl: stubFetch as any, budgetMs: 15000,
  });
  expect(result.company.name).toBe("Acme Widgets Inc.");
  expect(result.company.domain).toBe(DOMAIN);
  expect(result.company.description).toContain("fine widgets");
  expect(result.company.founded).toBe("1998");
  const names = result.principals.map((p) => p.name);
  for (const n of ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson", "Edsger Dijkstra"])
    expect(names).toContain(n);
  // graph: company + domain + person nodes, labeled edges
  const ids = nodes.map((n) => n.id);
  expect(ids).toContain("enrich:company:acme-example-com");
  expect(ids).toContain("urlscan:domain:acme-example-com");
  expect(ids.some((id) => id.startsWith("enrich:person:"))).toBe(true);
  const personEdge = edges.find((e) => e.from.startsWith("enrich:person:"));
  expect(personEdge).toBeTruthy();
  expect(["executive at", "founder of"]).toContain(personEdge!.label);
});

// ---------- collector: scrape + registry fold-in ----------

const CTX: any = {
  city: "Testville", lat: 0, lon: 0, bbox: { s: 0, w: 0, n: 0, e: 0 },
  country: "", countryCode: "", state: null, cityId: "city:testville",
  facts: { domains: [DOMAIN] },
};

test("collectEnrich folds registries into the scraped graph", async () => {
  globalThis.fetch = stubFetch as any;
  const r = await collectEnrich(CTX);
  const ids = r.nodes.map((n: any) => n.id);
  expect(ids).toContain("enrich:company:acme-example-com");
  expect(ids).toContain("gleif:549300abcdef12345678"); // registry node folded in
  expect(ids.some((id: string) => id.startsWith("enrich:person:"))).toBe(true);
  const link = r.edges.find((e: any) =>
    e.from === "gleif:549300abcdef12345678" && e.to === "enrich:company:acme-example-com");
  expect(link).toBeTruthy();
  expect(link.label).toBe("registry match");
  expect(r.note).toContain("principals");
});

test("collectEnrich idles with no stashed domains", async () => {
  const r = await collectEnrich({ ...CTX, facts: {} });
  expect(r.nodes).toEqual([]);
  expect(r.note).toContain("no company keywords");
});

// ---------- launch-form checkbox (DOM-stubbed) ----------

function makeEl(tag: string): any {
  const el: any = {
    tag, children: [], _html: "", textContent: "", value: "", checked: false,
    disabled: false, style: {}, dataset: {}, hidden: false,
    set innerHTML(v: string) { this._html = String(v); },
    get innerHTML() { return this._html; },
    appendChild(c: any) { this.children.push(c); return c; },
    querySelector(_s: string) { return makeEl("span"); },
    querySelectorAll(_s: string) { return []; },
    addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }),
    click() {}, focus() {}, setAttribute() {}, getAttribute: () => null,
    // canvas 2d context: no-op proxy so top-level setup code can run
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

test("launch form renders an enrich checkbox from /api/source-defs", async () => {
  const byId = new Map<string, any>();
  const docStub: any = {
    readyState: "loading", // boot() stays parked; we call the seam directly
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
  g.fetch = async (url: string) => jsonResponse({
    sources: [
      { key: "geocode", label: "Geocode · OpenStreetMap" },
      { key: "enrich", label: "Enrichment · company principals" },
    ],
  });
  try {
    const src = readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
    (0, eval)(src);
    await g.__meridian.renderSourceChecks();
    const box = byId.get("sourceChecks");
    const labels: string[] = box.children.map((c: any) => c._html);
    expect(labels.some((h) => h.includes('value="enrich"'))).toBe(true);
    expect(labels.some((h) => h.includes('value="geocode"'))).toBe(true);
  } finally {
    g.document = prevDoc; g.window = prevWin; g.fetch = prevFetch;
    delete g.__meridian;
  }
});

// ---------- /api/enrich job lifecycle (live server, canned network) ----------
// Boots the real server on a scratch port with the network stubbed: the full
// POST -> running -> done and POST -> running -> failed paths run end to end.

const API_PORT = 45691;
const API_BASE = `http://localhost:${API_PORT}`;
const UNRESOLVABLE = "Unresolvable Company Xyzzy";

/** Canned web for the lifecycle tests; passes the API server itself through. */
function lifecycleStub(url: string, init?: RequestInit): Promise<Response> {
  const u = String(url);
  if (u.includes(`localhost:${API_PORT}`) || u.includes(`127.0.0.1:${API_PORT}`))
    return realFetch(url, init);
  if (u.includes("html.duckduckgo.com")) {
    if (u.includes(encodeURIComponent(UNRESOLVABLE)))
      return Promise.resolve(htmlResponse("<html><body>no results</body></html>"));
    return Promise.resolve(htmlResponse(DDG_HTML));
  }
  if (u === `https://${DOMAIN}/robots.txt`) return Promise.resolve(htmlResponse(ROBOTS));
  if (u === `https://${DOMAIN}/`) return Promise.resolve(htmlResponse(HOME_HTML));
  if (u === `https://${DOMAIN}/team`) return Promise.resolve(htmlResponse(TEAM_HTML));
  if (u.includes("api.gleif.org")) return Promise.resolve(jsonResponse(GLEIF_JSON));
  if (u.includes("efts.sec.gov") || u.includes("data.sec.gov")) return Promise.resolve(jsonResponse(EMPTY_EFTS));
  if (u.includes("wikidata.org/w/api.php")) return Promise.resolve(jsonResponse(EMPTY_WD));
  return Promise.resolve(new Response("not found", { status: 404 }));
}

let apiBooted = false;
async function bootApi() {
  globalThis.fetch = lifecycleStub as any;
  if (!apiBooted) {
    apiBooted = true;
    process.env.PORT = String(API_PORT);
    await import("./server");
  }
}

async function pollEnrichJob(id: string, terminal: string[]): Promise<any> {
  const deadline = Date.now() + 25000;
  for (;;) {
    const r = await fetch(`${API_BASE}/api/enrich/${id}`);
    const j: any = await r.json();
    if (terminal.includes(j.status)) return j;
    if (Date.now() > deadline) throw new Error(`enrich job ${id} stuck in "${j.status}"`);
    await new Promise((r2) => setTimeout(r2, 100));
  }
}

const lifecycleJobIds: string[] = [];

test("POST /api/enrich runs running -> done with company, principals, graph", async () => {
  await bootApi();
  const post = await fetch(`${API_BASE}/api/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Acme Widgets" }),
  });
  expect(post.status).toBe(201);
  const created: any = await post.json();
  expect(created.status).toBe("running");
  expect(typeof created.job_id).toBe("string");
  lifecycleJobIds.push(created.job_id);

  const mid: any = await (await fetch(`${API_BASE}/api/enrich/${created.job_id}`)).json();
  expect(["running", "done"]).toContain(mid.status);

  const done = await pollEnrichJob(created.job_id, ["done", "failed"]);
  expect(done.status).toBe("done");
  expect(done.progress.done).toBe(4);
  expect(done.company.name).toBe("Acme Widgets Inc.");
  const names = (done.principals || []).map((p: any) => p.name);
  expect(names).toContain("Ada Lovelace");
  expect(names).toContain("Alan Turing");
  const ids = (done.nodes || []).map((n: any) => n.id);
  expect(ids).toContain("enrich:company:acme-example-com");
  expect(ids).toContain("gleif:549300abcdef12345678"); // registry folded in
  expect(done.edges.length).toBeGreaterThan(0);

  const list: any = await (await fetch(`${API_BASE}/api/enrich`)).json();
  expect(list.jobs.some((j: any) => j.id === created.job_id)).toBe(true);
}, 30000);

test("POST /api/enrich runs running -> failed when nothing resolves", async () => {
  await bootApi();
  const post = await fetch(`${API_BASE}/api/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: UNRESOLVABLE }),
  });
  expect(post.status).toBe(201);
  const created: any = await post.json();
  lifecycleJobIds.push(created.job_id);

  const failed = await pollEnrichJob(created.job_id, ["done", "failed"]);
  expect(failed.status).toBe("failed");
  expect(String(failed.error)).toMatch(/couldn't resolve/i);
}, 30000);

test("POST /api/enrich 400s without a query; GET 404s unknown jobs", async () => {
  await bootApi();
  const bad = await fetch(`${API_BASE}/api/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "   " }),
  });
  expect(bad.status).toBe(400);
  const missing = await fetch(`${API_BASE}/api/enrich/enope123`);
  expect(missing.status).toBe(404);
}, 30000);

// Remove the lifecycle jobs so the dev database stays clean.
test("lifecycle cleanup", async () => {
  const { db } = await import("./db");
  for (const id of lifecycleJobIds)
    db.query("DELETE FROM enrich_jobs WHERE id = ?").run(id);
  expect(lifecycleJobIds.length).toBe(2);
});
