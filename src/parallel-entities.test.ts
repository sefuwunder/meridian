// meridian — tests for the Parallel FindAll entity-search collector (#42).
// Network is stubbed via globalThis.fetch; the key is supplied through the
// env var (env wins in resolveKey) so no real key is ever needed.
import { test, expect, afterEach } from "bun:test";
import {
  collectParallelEntities, parseParallelEntities, parallelEntitiesObjective,
  SOURCE_DEFS, BUSINESS_SOURCES, type Ctx,
} from "./sources";
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
  country: "Testland", countryCode: "TL", state: null, cityId: "city:testville",
  facts: {},
};

// ---------- parse ----------

test("parseParallelEntities maps entities, drops junk, dedupes, caps", () => {
  const j = {
    entity_set_id: "entity_set_abc",
    entities: [
      { name: "Acme Corp", url: "https://acme.com", description: "Widgets." },
      { name: "Acme Corp (mirror)", url: "https://acme.com/?utm_source=newsletter", description: "dup after tracking-param strip" },
      { name: "", url: "https://noname.com", description: "no name" },
      { name: "No URL Inc", url: "", description: "no url" },
      { name: "Bad URL LLC", url: "notaurl", description: "junk" },
      null,
      { name: "Beta Ltd", url: "https://beta.example", description: "" },
    ],
  };
  const out = parseParallelEntities(j);
  expect(out.length).toBe(2);
  expect(out[0]).toEqual({ name: "Acme Corp", url: "https://acme.com", description: "Widgets." });
  expect(out[1].name).toBe("Beta Ltd");
  expect(parseParallelEntities({}, 25)).toEqual([]);
  expect(parseParallelEntities({ entities: null })).toEqual([]);
});

test("parseParallelEntities honors the cap", () => {
  const j = {
    entities: Array.from({ length: 40 }, (_, i) => ({
      name: `Co ${i}`, url: `https://co${i}.example`, description: "",
    })),
  };
  expect(parseParallelEntities(j, 10).length).toBe(10);
});

// ---------- objective ----------

test("parallelEntitiesObjective anchors on the recon city", () => {
  const o = parallelEntitiesObjective(CTX);
  expect(o).toContain("Testville");
  expect(o).toContain("Testland");
  expect(o.toLowerCase()).toContain("companies");
});

// ---------- idle without key ----------

test("collectParallelEntities idles with no key and makes no request", async () => {
  delete process.env.PARALLEL_API_KEY;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return jsonResponse({}); }) as any;
  const r = await collectParallelEntities(CTX);
  expect(r.nodes).toEqual([]);
  expect(r.edges).toEqual([]);
  expect(r.note).toMatch(/idle/i);
  expect(calls).toBe(0);
});

// ---------- stubbed success ----------

const ENTITY_PAGE = {
  entity_set_id: "entity_set_abc",
  entities: [
    { name: "Acme Corp", url: "https://acme.com", description: "Widget manufacturer in Testville." },
    { name: "Beta Ltd", url: "https://beta.example/about", description: "Logistics." },
    { name: "Junk", url: "notaurl", description: "dropped" },
  ],
};

function stubEntitySearch(page: any, status = 200, onCall?: (body: any, headers: any) => void) {
  return (async (url: string, init?: any) => {
    expect(url).toBe("https://api.parallel.ai/v1beta/findall/entity-search");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init.body);
    onCall?.(body, init.headers);
    return jsonResponse(page, status);
  }) as any;
}

test("collectParallelEntities emits org/company nodes wired to the city hub", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  const bodies: any[] = [];
  const headerSeen: string[] = [];
  globalThis.fetch = stubEntitySearch(ENTITY_PAGE, 200, (body, headers) => {
    bodies.push(body);
    headerSeen.push(headers["x-api-key"]);
  });
  const r = await collectParallelEntities(CTX);
  // request contract: x-api-key (not Bearer), companies, limit 25
  expect(headerSeen).toEqual(["test-key"]);
  expect(bodies.length).toBe(1);
  expect(bodies[0].entity_type).toBe("companies");
  expect(bodies[0].match_limit).toBe(25);
  expect(bodies[0].objective).toContain("Testville");
  // nodes
  expect(r.nodes.length).toBe(2);
  expect(r.nodes[0].type).toBe("org");
  expect(r.nodes[0].subtype).toBe("company");
  expect(r.nodes[0].label).toBe("Acme Corp");
  expect(r.nodes[0].source).toBe("parallel-entities");
  expect(r.nodes[0].detail).toContain("Widget manufacturer");
  expect(r.nodes[0].id.startsWith("parallelent:")).toBe(true);
  // every node gets a company edge from the city hub
  expect(r.edges.length).toBe(2);
  for (const e of r.edges) {
    expect(e.from).toBe("city:testville");
    expect(e.label).toBe("company");
  }
  expect(r.note).toContain("2 companies");
});

// ---------- failure classification ----------

test("collectParallelEntities throws auth-flavored error on 401", async () => {
  process.env.PARALLEL_API_KEY = "bad-key";
  globalThis.fetch = stubEntitySearch({}, 401);
  await expect(collectParallelEntities(CTX)).rejects.toThrow(/invalid API key/i);
});

test("collectParallelEntities throws quota-flavored error on 402", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  globalThis.fetch = stubEntitySearch({}, 402);
  await expect(collectParallelEntities(CTX)).rejects.toThrow(/quota/i);
});

test("collectParallelEntities throws rate-limit error on 429", async () => {
  process.env.PARALLEL_API_KEY = "test-key";
  globalThis.fetch = stubEntitySearch({}, 429);
  await expect(collectParallelEntities(CTX)).rejects.toThrow(/rate-limited/i);
});

// ---------- business classification ----------

test("parallel-entities is registered business:true and survives business-only filtering", () => {
  const def = SOURCE_DEFS.find((d) => d.key === "parallel-entities");
  expect(def).toBeDefined();
  expect(def!.business).toBe(true);
  expect(BUSINESS_SOURCES.has("parallel-entities")).toBe(true);
  expect(applyBusinessOnly(["parallel-entities", "parallel", "news", "geocode"]))
    .toEqual(["parallel-entities", "geocode"]);
});
