// meridian — entity model, transform registry, and investigation API tests.
// Transform runs are stubbed at the fetch layer (no network); the API test
// boots the real server against a temp data dir.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  ENTITY_TYPES, entityId, detectEntityType,
  getTransforms, transformsFor, findTransform,
  type EntityType,
} from "./transforms";

// ---------- entity model ----------

test("entity types: 12 Maltego-style types with icon + color", () => {
  const keys = Object.keys(ENTITY_TYPES);
  expect(keys.length).toBe(12);
  for (const k of keys) {
    const m = ENTITY_TYPES[k as EntityType];
    expect(m.label.length).toBeGreaterThan(0);
    expect(m.icon.length).toBeGreaterThan(0);
    expect(m.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  }
  expect(ENTITY_TYPES.domain.icon).toBe("🌐");
  expect(ENTITY_TYPES.person.color).toBe("#E8A838");
});

test("entityId is deterministic and type-scoped", () => {
  expect(entityId("domain", "Example.COM")).toBe("domain:example-com");
  expect(entityId("domain", "Example.COM")).toBe(entityId("domain", "example.com"));
  expect(entityId("ip", "Example.COM")).not.toBe(entityId("domain", "Example.COM"));
  expect(entityId("company", "Acme & Sons!")).toBe("company:acme-sons");
});

test("detectEntityType: ip, email, phone, url, domain, netblock, fallback", () => {
  expect(detectEntityType("8.8.8.8")).toBe("ip");
  expect(detectEntityType("2001:4860:4860::8888")).toBe("ip");
  expect(detectEntityType("jane@acme.com")).toBe("email");
  expect(detectEntityType("+1 513-555-0142")).toBe("phone");
  expect(detectEntityType("https://example.com/path")).toBe("url");
  expect(detectEntityType("example.com")).toBe("domain");
  expect(detectEntityType("10.0.0.0/8")).toBe("netblock");
  expect(detectEntityType("Acme Corporation")).toBe("company");
  expect(detectEntityType("  EXAMPLE.com  ")).toBe("domain"); // trimmed
});

// ---------- transform registry ----------

test("registry: 13 transforms, all well-formed", async () => {
  const ts = await getTransforms();
  expect(ts.length).toBe(13);
  const keys = new Set<string>();
  for (const t of ts) {
    expect(t.key.length).toBeGreaterThan(0);
    expect(t.label.length).toBeGreaterThan(0);
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.inputTypes.length).toBeGreaterThan(0);
    for (const it of t.inputTypes) expect(ENTITY_TYPES[it]).toBeTruthy();
    expect(keys.has(t.key)).toBe(false);
    keys.add(t.key);
  }
});

test("transformsFor: domain gets 4 transforms incl. web-search", async () => {
  const ts = await transformsFor("domain");
  const keys = ts.map((t) => t.key);
  expect(keys).toContain("cert-subdomains");
  expect(keys).toContain("dns-history");
  expect(keys).toContain("domain-scans");
  expect(keys).toContain("web-search");
  expect(keys).not.toContain("ip-ports");
});

test("transformsFor: every entity type except note has at least one transform", async () => {
  for (const t of Object.keys(ENTITY_TYPES)) {
    if (t === "note") continue; // analyst-created, terminal by design
    const ts = await transformsFor(t as EntityType);
    expect(ts.length).toBeGreaterThan(0);
  }
});

test("findTransform: known and unknown keys", async () => {
  expect((await findTransform("ip-intel"))?.label).toMatch(/IPQuery/);
  expect(await findTransform("nope")).toBeUndefined();
});

// ---------- transform runs (fetch stubbed) ----------

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string) => any) {
  (globalThis as any).fetch = async (url: string | URL, _opts?: any) => {
    const body = handler(String(url));
    return { ok: true, status: 200, json: async () => body } as any;
  };
}
afterAll(() => { (globalThis as any).fetch = realFetch; });

test("cert-subdomains: parses CT issuances, skips parent + wildcards", async () => {
  stubFetch((url) => {
    expect(url).toContain("certspotter");
    return [
      { dns_names: ["example.com", "*.example.com", "a.example.com", "b.example.com."], issuer: { o: "Let's Encrypt" } },
      { dns_names: ["a.example.com", "other.net"], issuer: {} },
    ];
  });
  const t = (await findTransform("cert-subdomains"))!;
  const r = await t.run({ id: "domain:example-com", type: "domain", value: "example.com", label: "example.com", properties: {}, source: "seed" }, {});
  expect(r.entities.map((e) => e.value).sort()).toEqual(["a.example.com", "b.example.com", "other.net"]);
  expect(r.entities[0].type).toBe("domain");
  expect(r.entities[0].properties.issuer).toBe("Let's Encrypt");
  const sub = r.links.find((l) => l.to === "domain:a-example-com");
  expect(sub?.label).toBe("subdomain of");
  expect(r.note).toMatch(/3 DNS names/);
});

test("dns-history: A records → ip entities, CNAME → domain entities", async () => {
  stubFetch(() => ({
    data: [
      { answer: "93.184.216.34", rrtype: "A", times: 500, lastSeenTimestamp: 1727740800000 },
      { answer: "alias.example.com.", rrtype: "CNAME", times: 12, lastSeenTimestamp: 0 },
      { answer: "x", rrtype: "MX", times: 99 },
    ],
  }));
  const t = (await findTransform("dns-history"))!;
  const r = await t.run({ id: "domain:example-com", type: "domain", value: "example.com", label: "e", properties: {}, source: "s" }, {});
  const ip = r.entities.find((e) => e.type === "ip");
  const cn = r.entities.find((e) => e.type === "domain" && e.value === "alias.example.com");
  expect(ip?.value).toBe("93.184.216.34");
  expect(ip?.properties.observations).toBe("500");
  expect(cn).toBeTruthy();
  expect(r.links.find((l) => l.to === ip!.id)?.label).toBe("resolves");
  expect(r.links.find((l) => l.to === cn!.id)?.label).toBe("points to");
});

test("ip-ports: internetdb 404-ish body → graceful empty", async () => {
  stubFetch(() => ({})); // no .ip → unknown host
  const t = (await findTransform("ip-ports"))!;
  const r = await t.run({ id: "ip:1-2-3-4", type: "ip", value: "1.2.3.4", label: "1.2.3.4", properties: {}, source: "s" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no data/);
});

test("ip-ports: parses ports, vulns, hostnames", async () => {
  stubFetch(() => ({ ip: "1.2.3.4", ports: [80, 443], vulns: ["CVE-2021-1"], hostnames: ["host.example.com"], tags: ["web"] }));
  const t = (await findTransform("ip-ports"))!;
  const r = await t.run({ id: "ip:1-2-3-4", type: "ip", value: "1.2.3.4", label: "1.2.3.4", properties: {}, source: "s" }, {});
  const self = r.entities.find((e) => e.id === "ip:1-2-3-4");
  expect(self?.properties.ports).toBe("80, 443");
  expect(self?.properties.vulns).toContain("CVE-2021-1");
  expect(r.entities.some((e) => e.type === "domain" && e.value === "host.example.com")).toBe(true);
});

test("company-gleif: LEI records with parent links", async () => {
  stubFetch(() => ({
    data: [{
      id: "529900T8BM49AURSDO55",
      attributes: {
        entity: { legalName: { name: "ACME CORP" }, legalAddress: { city: "Berlin", country: "DE" }, status: "ACTIVE" },
      },
      relationships: { "direct-parent": { relationships: { parent: { data: { id: "984500QOZ5H5E9I0D267" } } } } },
    }],
  }));
  const t = (await findTransform("company-gleif"))!;
  const r = await t.run({ id: "company:acme", type: "company", value: "Acme", label: "Acme", properties: {}, source: "s" }, {});
  const co = r.entities.find((e) => e.properties.lei === "529900T8BM49AURSDO55");
  expect(co).toBeTruthy();
  expect(co?.properties.address).toBe("Berlin, DE");
  expect(r.links.some((l) => l.label === "direct parent")).toBe(true);
});

test("transform run never throws: network failure → failed note", async () => {
  (globalThis as any).fetch = async () => { throw new Error("boom"); };
  const t = (await findTransform("ip-intel"))!;
  const r = await t.run({ id: "ip:1-2-3-4", type: "ip", value: "1.2.3.4", label: "1.2.3.4", properties: {}, source: "s" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/^failed:/);
});

test("web-search without key → key-missing note (no throw)", async () => {
  stubFetch(() => { throw new Error("should not fetch without key"); });
  const t = (await findTransform("web-search"))!;
  const r = await t.run({ id: "domain:example-com", type: "domain", value: "example.com", label: "e", properties: {}, source: "s" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/key missing/i);
});
