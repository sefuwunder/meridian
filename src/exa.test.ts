// meridian — tests for the Exa web-search collector (#40), the EXA_API_KEY
// key def, and business-only exclusion. Network is stubbed via
// globalThis.fetch; the key is supplied through the env var (env wins in
// resolveKey) so no real key is ever needed.
import { test, expect, afterEach } from "bun:test";
import { readFileSync } from "fs";
import {
  collectExa, parseExaResults, normalizeWebUrl, probeKeySource,
  SOURCE_DEFS, BUSINESS_SOURCES, type Ctx,
} from "./sources";
import { KEY_DEFS } from "./keys";
import { keyStatuses } from "./keys";
import { applyBusinessOnly } from "./router";

const realFetch = globalThis.fetch as any;
const realEnvKey = process.env.EXA_API_KEY;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnvKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = realEnvKey;
});

function jsonResponse(v: any, status = 200): Response {
  return new Response(JSON.stringify(v), {
    status, headers: { "Content-Type": "application/json" },
  });
}

const CTX: Ctx = {
  city: "Testville", lat: 0, lon: 0, bbox: { s: 0, w: 0, n: 0, e: 0 },
  country: "", countryCode: "", state: null, cityId: "city:testville",
  facts: { domains: ["acme.com"] },
};

// ---------- key def ----------

test("EXA_API_KEY is a required key def pointing at dashboard.exa.ai", () => {
  const def = KEY_DEFS.find((d) => d.id === "EXA_API_KEY");
  expect(def).toBeDefined();
  expect(def!.required).toBe(true);
  expect(def!.signup).toContain("dashboard.exa.ai");
  expect(keyStatuses().some((k) => k.id === "EXA_API_KEY")).toBe(true);
});

// ---------- idle without key ----------

test("collectExa idles with no key and makes no request", async () => {
  delete process.env.EXA_API_KEY;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return jsonResponse({}); }) as any;
  const r = await collectExa(CTX);
  expect(r.nodes).toEqual([]);
  expect(r.edges).toEqual([]);
  expect(r.note).toMatch(/idle/i);
  expect(calls).toBe(0);
});

// ---------- idle without keywords ----------

test("collectExa idles with a key but no stashed domains", async () => {
  process.env.EXA_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return jsonResponse({}); }) as any;
  const r = await collectExa({ ...CTX, facts: {} });
  expect(r.nodes).toEqual([]);
  expect(r.note).toContain("no company keywords");
  expect(calls).toBe(0);
});

// ---------- stubbed success ----------

const EXA_PAGE = {
  results: [
    { title: "Acme raises Series B", url: "https://news.example.com/acme-b?utm_source=newsletter", text: "Acme raised $40m to expand widget production." },
    { title: "Acme raises Series B (mirror)", url: "https://news.example.com/acme-b", text: "duplicate after tracking-param strip" },
    { title: "", url: "https://acme.example.com/about", text: "About Acme." },
    { title: "Acme in the press", url: "https://press.example.org/acme#frag", highlights: ["Acme opened a new plant."] },
    { url: "notaurl" },
    { title: "junk", url: "" },
  ],
};

function stubExa(page: any, onCall?: (body: any, headers: any) => void) {
  return (async (url: string, init?: any) => {
    expect(url).toBe("https://api.exa.ai/search");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init.body);
    onCall?.(body, init.headers);
    return jsonResponse(page);
  }) as any;
}

test("collectExa emits web nodes + web-result edges, dedupes by URL", async () => {
  process.env.EXA_API_KEY = "test-key";
  const bodies: any[] = [];
  globalThis.fetch = stubExa(EXA_PAGE, (body, headers) => {
    bodies.push(body);
    expect(headers["x-api-key"]).toBe("test-key");
    expect(body.type).toBe("keyword");
    expect(body.numResults).toBe(5);
    expect(body.text).toBe(true);
  });
  const r = await collectExa(CTX);
  expect(bodies.map((b) => b.query)).toEqual(["acme"]);
  // 6 raw results: 1 utm-dupe + 2 junk = 3 nodes
  expect(r.nodes).toHaveLength(3);
  for (const n of r.nodes) {
    expect(n.type).toBe("data");
    expect(n.subtype).toBe("web");
    expect(n.source).toBe("exa");
    expect(n.id.startsWith("exa:")).toBe(true);
    expect(n.url).toMatch(/^https?:\/\//);
  }
  const titles = r.nodes.map((n) => n.label);
  expect(titles).toContain("Acme raises Series B");
  // missing title falls back to the URL
  expect(titles).toContain("https://acme.example.com/about");
  // missing text falls back to the first highlight
  const press = r.nodes.find((n) => n.url === "https://press.example.org/acme#frag");
  expect(press!.detail).toContain("Acme opened a new plant.");
  // one edge to the stashed-company node + one to the city hub per result
  expect(r.edges).toHaveLength(6);
  for (const n of r.nodes) {
    const e1 = r.edges.find((e) => e.to === n.id && e.from === "urlscan:domain:acme-com");
    const e2 = r.edges.find((e) => e.to === n.id && e.from === "city:testville");
    expect(e1?.label).toBe("web result");
    expect(e2?.label).toBe("web result");
  }
  expect(r.note).toContain("3 web results");
});

test("collectExa caps at 3 keywords × 5 results per run", async () => {
  process.env.EXA_API_KEY = "test-key";
  const queries: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const body = JSON.parse(init.body);
    queries.push(body.query);
    // per-query URLs so cross-query dedupe doesn't collapse them
    return jsonResponse({
      results: Array.from({ length: 9 }, (_, i) => ({
        title: `${body.query} hit ${i}`, url: `https://${body.query}.example/${i}`, text: "t",
      })),
    });
  }) as any;
  const ctx = { ...CTX, facts: { domains: ["alpha.com", "beta.com", "gamma.com", "delta.com", "epsilon.com"] } };
  const r = await collectExa(ctx);
  expect(queries).toEqual(["alpha", "beta", "gamma"]); // keyword cap: 3 requests
  expect(r.nodes).toHaveLength(15);            // 3 × 5 results
  expect(r.note).toContain("15 web results");
});

// ---------- error classification ----------

test("collectExa throws an auth-flavored error on 401", async () => {
  process.env.EXA_API_KEY = "bad-key";
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as any;
  await expect(collectExa(CTX)).rejects.toThrow(/invalid API key|401/);
});

test("collectExa throws quota/rate-limit errors on 402 and 429", async () => {
  process.env.EXA_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response("x", { status: 402 })) as any;
  await expect(collectExa(CTX)).rejects.toThrow(/quota/i);
  globalThis.fetch = (async () => new Response("x", { status: 429 })) as any;
  await expect(collectExa(CTX)).rejects.toThrow(/rate-limited/i);
});

// ---------- pure helpers ----------

test("parseExaResults is defensive about junk rows", () => {
  expect(parseExaResults(null)).toEqual([]);
  expect(parseExaResults({})).toEqual([]);
  expect(parseExaResults({ results: [null, 42, { url: "ftp://x/y" }] })).toEqual([]);
  expect(parseExaResults({ results: [{ url: "https://a.example/" }] })[0].snippet).toBe("");
});

test("normalizeWebUrl strips tracking params, hash and case", () => {
  expect(normalizeWebUrl("https://Example.COM/a?b=1&utm_source=x#frag"))
    .toBe("https://example.com/a?b=1");
  expect(normalizeWebUrl("https://example.com/a?gclid=1&fbclid=2"))
    .toBe("https://example.com/a");
  expect(normalizeWebUrl("nota url")).toBe("nota url");
});

// ---------- probe (Keys screen "test" button) ----------

test("probeKeySource(EXA_API_KEY) authenticates via a tiny search", async () => {
  let method = "";
  globalThis.fetch = (async (url: string, init?: any) => {
    method = init?.method;
    expect(url).toBe("https://api.exa.ai/search");
    expect(init?.headers?.["x-api-key"]).toBe("probe-key");
    return jsonResponse({ results: [{ title: "t", url: "https://t.example/" }] });
  }) as any;
  const r = await probeKeySource("EXA_API_KEY", "probe-key");
  expect(method).toBe("POST");
  expect(r.ok).toBe(true);
  expect(r.detail).toMatch(/authenticated/);
});

// ---------- business-only classification ----------

test("exa is registered with business:false and outside BUSINESS_SOURCES", () => {
  const def = SOURCE_DEFS.find((d) => d.key === "exa");
  expect(def).toBeDefined();
  expect(def!.label).toContain("Exa");
  expect(typeof def!.business).toBe("boolean");
  expect(def!.business).toBe(false);
  expect(BUSINESS_SOURCES.has("exa")).toBe(false);
});

test("applyBusinessOnly excludes exa but keeps geocode", () => {
  const out = applyBusinessOnly(["geocode", "exa", "business", "news"]);
  expect(out).toEqual(["geocode", "business"]);
});

// ---------- transform panel (DOM-stubbed) ----------
// The pivot replaced the recon launch form: per-entity transforms are now the
// "source" surface, rendered by renderDetail() into the transform panel.

function makeEl(tag: string): any {
  const el: any = {
    tag, children: [], _html: "", textContent: "", value: "", checked: false,
    disabled: false, style: {}, dataset: {}, hidden: false, className: "",
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

function bootStub() {
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
  const prev = { document: g.document, window: g.window, fetch: g.fetch };
  g.document = docStub;
  g.window = g;
  g.fetch = async () => ({ ok: true, json: async () => ({}) });
  const src = readFileSync(new URL("../public/app.js", import.meta.url).pathname, "utf8");
  (0, eval)(src);
  return { byId, g, prev };
}
function unboot(byId: any, g: any, prev: any) {
  g.document = prev.document; g.window = prev.window; g.fetch = prev.fetch;
  delete g.__meridian;
}

test("entity detail shows applicable transforms for a domain", async () => {
  const { byId, g, prev } = bootStub();
  try {
    const M = g.__meridian;
    M.S.types = { domain: { label: "Domain", icon: "🌐", color: "#4A90D9" } };
    M.S.transforms = [
      { key: "cert-subdomains", label: "Subdomains · Cert Spotter", description: "CT logs", inputTypes: ["domain"] },
      { key: "ip-ports", label: "Ports · Shodan", description: "ports", inputTypes: ["ip"] },
    ];
    M.S.sim.set("domain:example-com", {
      id: "domain:example-com", type: "domain", value: "example.com", label: "example.com",
      properties: { issuer: "Let's Encrypt" }, source: "certspotter",
      x: 0, y: 0, vx: 0, vy: 0, r: 22, hidden: false,
    });
    M.S.selected = "domain:example-com";
    M.renderDetail();
    const detail = byId.get("entityDetail")._html;
    expect(detail).toContain("example.com");
    expect(detail).toContain("Let&#39;s Encrypt");
    expect(byId.get("transformPanel").hidden).toBe(false);
    const tl = byId.get("transformList")._html;
    expect(tl).toContain("cert-subdomains");
    expect(tl).not.toContain("ip-ports");
  } finally { unboot(byId, g, prev); }
});

test("entity detail with no selection shows the empty state", async () => {
  const { byId, g, prev } = bootStub();
  try {
    const M = g.__meridian;
    M.S.selected = null;
    M.renderDetail();
    expect(byId.get("entityDetail")._html).toContain("click any entity");
    expect(byId.get("transformPanel").hidden).toBe(true);
  } finally { unboot(byId, g, prev); }
});

// ---------- Keys modal rows (DOM-stubbed) ----------

test("Keys modal renders key rows without leaking values", async () => {
  const { byId, g, prev } = bootStub();
  g.fetch = async (url: string) => ({
    ok: true,
    json: async () => ({
      keys: [{
        id: "EXA_API_KEY", name: "Exa", masked: "••••test",
        benefit: "1,000 searches", signup: "https://dashboard.exa.ai",
        signupLabel: "exa dashboard",
      }],
    }),
  });
  try {
    await g.__meridian.refreshKeys();
    const html = byId.get("keyList")._html;
    expect(html).toContain("Exa");
    expect(html).toContain("••••test");
    expect(html).toContain("dashboard.exa.ai");
    expect(html).not.toContain("test-key-full-value");
  } finally { unboot(byId, g, prev); }
});
