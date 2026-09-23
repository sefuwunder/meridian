// meridian — tests for the Parallel web-search collector (#41), the
// PARALLEL_API_KEY key def, and business-only exclusion. Network is stubbed
// via globalThis.fetch; the key is supplied through the env var (env wins in
// resolveKey) so no real key is ever needed.
import { test, expect, afterEach } from "bun:test";
import {
  collectParallel, parseParallelResults,
  probeKeySource, SOURCE_DEFS, BUSINESS_SOURCES, type Ctx,
} from "./sources";
import { KEY_DEFS, keyStatuses } from "./keys";
import { applyBusinessOnly } from "./router";

const realFetch = globalThis.fetch as any;
const realEnvKey = process.env.PARALLEL_API_KEY;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnvKey === undefined) delete process.env.PARALLEL_API_KEY;
  else process.env.PARALLEL_API_KEY = realEnvKey;
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

test("PARALLEL_API_KEY is a required key def pointing at platform.parallel.ai", () => {
  const def = KEY_DEFS.find((d) => d.id === "PARALLEL_API_KEY");
  expect(def).toBeDefined();
  expect(def!.required).toBe(true);
  expect(def!.signup).toContain("platform.parallel.ai");
  expect(keyStatuses().some((k) => k.id === "PARALLEL_API_KEY")).toBe(true);
});

// ---------- idle without key ----------

test("collectParallel idles with no key and makes no request", async () => {
  delete process.env.PARALLEL_API_KEY;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return jsonResponse({}); }) as any;
  const r = await collectParallel(CTX);
  expect(r.nodes).toEqual([]);
  expect(r.edges).toEqual([]);
  expect(r.note).toMatch(/idle/i);
  expect(calls).toBe(0);
});

// ---------- idle without keywords ----------

test("collectParallel idles with a key but no stashed domains", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return jsonResponse({}); }) as any;
  const r = await collectParallel({ ...CTX, facts: {} });
  expect(r.nodes).toEqual([]);
  expect(r.note).toContain("no company keywords");
  expect(calls).toBe(0);
});

// ---------- stubbed success ----------

const PARALLEL_PAGE = {
  search_id: "search_abc",
  session_id: "session_abc",
  results: [
    { title: "Acme raises Series B", url: "https://news.example.com/acme-b?utm_source=newsletter", publish_date: "2026-09-01", excerpts: ["Acme raised $40m", "to expand widget production."] },
    { title: "Acme raises Series B (mirror)", url: "https://news.example.com/acme-b", excerpts: ["duplicate after tracking-param strip"] },
    { title: "", url: "https://acme.example.com/about", publish_date: "2024-05-01", excerpts: ["About Acme."] },
    { url: "notaurl", excerpts: ["junk"] },
    { title: "junk", url: "", excerpts: ["junk"] },
  ],
};

function stubParallel(page: any, onCall?: (body: any, headers: any) => void) {
  return (async (url: string, init?: any) => {
    expect(url).toBe("https://api.parallel.ai/v1/search");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init.body);
    onCall?.(body, init.headers);
    return jsonResponse(page);
  }) as any;
}

test("collectParallel emits web nodes + web-result edges, dedupes by URL", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  const bodies: any[] = [];
  globalThis.fetch = stubParallel(PARALLEL_PAGE, (body, headers) => {
    bodies.push(body);
    expect(headers["Authorization"]).toBe("Bearer test-key");
    expect(body.mode).toBe("basic");
    expect(body.max_chars_total).toBe(6000);
    expect(typeof body.objective).toBe("string");
    expect(body.objective).toContain("acme");
  });
  const r = await collectParallel(CTX);
  expect(bodies.map((b) => b.search_queries)).toEqual([["acme"]]);
  // 5 raw results: 1 utm-dupe + 2 junk = 2 nodes
  expect(r.nodes).toHaveLength(2);
  for (const n of r.nodes) {
    expect(n.type).toBe("data");
    expect(n.subtype).toBe("web");
    expect(n.source).toBe("parallel");
    expect(n.id.startsWith("parallel:")).toBe(true);
    expect(n.url).toMatch(/^https?:\/\//);
  }
  const titles = r.nodes.map((n) => n.label);
  expect(titles).toContain("Acme raises Series B");
  // missing title falls back to the URL
  expect(titles).toContain("https://acme.example.com/about");
  // excerpts are joined into the snippet; publish date is appended
  const series = r.nodes.find((n) => n.url === "https://news.example.com/acme-b?utm_source=newsletter");
  expect(series!.detail).toContain("Acme raised $40m to expand widget production.");
  expect(series!.detail).toContain("published 2026-09-01");
  // one edge to the stashed-company node + one to the city hub per result
  expect(r.edges).toHaveLength(4);
  for (const n of r.nodes) {
    const e1 = r.edges.find((e) => e.to === n.id && e.from === "urlscan:domain:acme-com");
    const e2 = r.edges.find((e) => e.to === n.id && e.from === "city:testville");
    expect(e1?.label).toBe("web result");
    expect(e2?.label).toBe("web result");
  }
  expect(r.note).toContain("2 web results");
});

test("collectParallel caps at 3 keywords × 5 results per run", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  const queries: string[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    const body = JSON.parse(init.body);
    queries.push(body.search_queries[0]);
    // per-query URLs so cross-query dedupe doesn't collapse them
    return jsonResponse({
      results: Array.from({ length: 9 }, (_, i) => ({
        title: `${body.search_queries[0]} hit ${i}`,
        url: `https://${body.search_queries[0]}.example/${i}`,
        excerpts: ["t"],
      })),
    });
  }) as any;
  const ctx = { ...CTX, facts: { domains: ["alpha.com", "beta.com", "gamma.com", "delta.com", "epsilon.com"] } };
  const r = await collectParallel(ctx);
  expect(queries).toEqual(["alpha", "beta", "gamma"]); // keyword cap: 3 requests
  expect(r.nodes).toHaveLength(15);            // 3 × 5 results
  expect(r.note).toContain("15 web results");
});

// ---------- error classification ----------

test("collectParallel throws an auth-flavored error on 401", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as any;
  await expect(collectParallel(CTX)).rejects.toThrow(/invalid API key|401/);
});

test("collectParallel throws quota/rate-limit errors on 402 and 429", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response("x", { status: 402 })) as any;
  await expect(collectParallel(CTX)).rejects.toThrow(/quota/i);
  globalThis.fetch = (async () => new Response("x", { status: 429 })) as any;
  await expect(collectParallel(CTX)).rejects.toThrow(/rate-limited/i);
});

test("collectParallel surfaces a generic error otherwise", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as any;
  await expect(collectParallel(CTX)).rejects.toThrow(/HTTP 500/);
});

// ---------- pure helpers ----------

test("parseParallelResults is defensive about junk rows", () => {
  expect(parseParallelResults(null)).toEqual([]);
  expect(parseParallelResults({})).toEqual([]);
  expect(parseParallelResults({ results: [null, 42, { url: "ftp://x/y" }] })).toEqual([]);
  expect(parseParallelResults({ results: [{ url: "https://a.example/" }] })[0].snippet).toBe("");
  expect(parseParallelResults({ results: [{ url: "https://a.example/" }] })[0].publishDate).toBeNull();
});

test("parseParallelResults joins excerpts and keeps publish_date", () => {
  const [r] = parseParallelResults({
    results: [{ title: "T", url: "https://a.example/x", publish_date: "2026-01-02", excerpts: ["one", 7, "two"] }],
  });
  expect(r.snippet).toBe("one two");
  expect(r.publishDate).toBe("2026-01-02");
});

// ---------- probe (Keys screen "test" button) ----------

test("probeKeySource(PARALLEL_API_KEY) authenticates via a tiny search", async () => {
  let method = "";
  globalThis.fetch = (async (url: string, init?: any) => {
    method = init?.method;
    expect(url).toBe("https://api.parallel.ai/v1/search");
    expect(init?.headers?.["Authorization"]).toBe("Bearer probe-key");
    const body = JSON.parse(init.body);
    expect(Array.isArray(body.search_queries)).toBe(true);
    return jsonResponse({ results: [{ title: "t", url: "https://t.example/", excerpts: [] }] });
  }) as any;
  const r = await probeKeySource("PARALLEL_API_KEY", "probe-key");
  expect(method).toBe("POST");
  expect(r.ok).toBe(true);
  expect(r.detail).toMatch(/authenticated/);
});

// ---------- business-only classification ----------

test("parallel is registered with business:false and outside BUSINESS_SOURCES", () => {
  const def = SOURCE_DEFS.find((d) => d.key === "parallel");
  expect(def).toBeDefined();
  expect(def!.label).toContain("Parallel");
  expect(typeof def!.business).toBe("boolean");
  expect(def!.business).toBe(false);
  expect(BUSINESS_SOURCES.has("parallel")).toBe(false);
});

test("applyBusinessOnly excludes parallel but keeps geocode", () => {
  const out = applyBusinessOnly(["geocode", "parallel", "business", "news"]);
  expect(out).toEqual(["geocode", "business"]);
});
