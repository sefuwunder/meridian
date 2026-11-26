// meridian — entity model, transform registry, and investigation API tests.
// Transform runs are stubbed at the fetch layer (no network); the API test
// boots the real server against a temp data dir.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ENTITY_TYPES, entityId, detectEntityType,
  getTransforms, transformsFor, findTransform,
  type EntityType,
} from "./transforms";

// ---------- entity model ----------

test("entity types: 13 Maltego-style types with icon + color", () => {
  const keys = Object.keys(ENTITY_TYPES);
  expect(keys.length).toBe(13);
  for (const k of keys) {
    const m = ENTITY_TYPES[k as EntityType];
    expect(m.label.length).toBeGreaterThan(0);
    expect(m.icon.length).toBeGreaterThan(0);
    expect(m.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  }
  expect(ENTITY_TYPES.domain.icon).toBe("🌐");
  expect(ENTITY_TYPES.person.color).toBe("#E8A838");
  expect(ENTITY_TYPES.wallet.label).toBe("Wallet");
  expect(ENTITY_TYPES.wallet.icon).toBe("👛");
  expect(ENTITY_TYPES.wallet.color).toBe("#D35400");
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

test("registry: 35 transforms, all well-formed", async () => {
  const ts = await getTransforms();
  expect(ts.length).toBe(35);
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

test("transformsFor: domain gets 6 transforms incl. web-search", async () => {
  const ts = await transformsFor("domain");
  const keys = ts.map((t) => t.key);
  expect(keys).toContain("cert-subdomains");
  expect(keys).toContain("dns-history");
  expect(keys).toContain("domain-scans");
  expect(keys).toContain("domain-footprint");
  expect(keys).toContain("domain-opencograph");
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

test("registry: every transform carries an explicit business boolean", async () => {
  const ts = await getTransforms();
  for (const t of ts) {
    expect(typeof t.business, `${t.key} must have an explicit business boolean`).toBe("boolean");
  }
});

// Pinned deliberately: reclassifying a transform must update this test as
// a conscious act, never silently (same pattern as business-scope.test.ts).
const EXPECTED_BUSINESS_TRANSFORMS = [
  "company-gleif", "company-findall", "company-sec", "company-cyprus",
  "company-sudokn", "company-traderegister", "company-opencograph",
  "domain-opencograph", "location-places",
  "company-companyregistry", "company-wsystem", "company-regbase",
  "ip-vpndetection", "wallet-fills", "wallet-helius",
  "company-patents",
  "company-vendorhistory", "company-cdr",
];

test("business transforms are exactly the audited set", async () => {
  const ts = await getTransforms();
  const got = ts.filter((t) => t.business).map((t) => t.key).sort();
  expect(got).toEqual([...EXPECTED_BUSINESS_TRANSFORMS].sort());
  expect((await findTransform("company-traderegister"))?.business).toBe(true);
});

test("findTransform: known and unknown keys", async () => {
  expect((await findTransform("ip-intel"))?.label).toMatch(/IPQuery/);
  expect(await findTransform("nope")).toBeUndefined();
});

test("company-cyprus: temporarily disabled, not offered, code intact", async () => {
  // Registry still holds it (re-enable = drop one field), but no surface
  // offers it and no run can reach the dead endpoint.
  const all = await getTransforms();
  expect(all.length).toBe(35);
  const cy = all.find((t) => t.key === "company-cyprus")!;
  expect(cy.disabled).toMatch(/HTTP 404 since 2026-10-26/);
  expect(cy.inputTypes).toContain("company");
  expect(typeof cy.run).toBe("function");
  const offered = await transformsFor("company");
  expect(offered.map((t) => t.key)).not.toContain("company-cyprus");
  expect(offered.length).toBeGreaterThan(0); // company still has live transforms
  expect((await findTransform("company-cyprus"))?.disabled).toBeTruthy();
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

test("company-sudokn: manufacturers with address, geo, certs", async () => {
  const C = "http://asu.edu/semantics/SUDOKN/101machine.com-company-instance";
  stubFetch((url) => {
    expect(url).toContain("apps.okn.us/sudokn/sparql");
    if (url.includes("Manufacturer")) {
      return { results: { bindings: [{ s: { value: C }, name: { value: "101 Machine" } }] } };
    }
    if (url.includes("BIND(")) {
      return { results: { bindings: [
        { kind: { value: "cert" }, label: { value: "ISO 9001 Certificate" } },
        { kind: { value: "industry" }, label: { value: "Aerospace" } },
        { kind: { value: "process" }, label: { value: "CNC Machining" } },
      ] } };
    }
    return { results: { bindings: [{
      desc: { value: "Prototype machine shop" }, emp: { value: "3" },
      web: { value: "101machine.com" }, email: { value: "info@101machine.com" },
      street: { value: "1937 Evans Rd" }, postal: { value: "27513" }, phone: { value: "919-650-3795" },
      city: { value: "Cary" }, state: { value: "North Carolina" }, country: { value: "US" },
      wkt: { value: "POINT(-78.803482 35.819162)" }, naics: { value: "Machine Shops" },
    }] } };
  });
  const t = (await findTransform("company-sudokn"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ id: "company:acme", type: "company", value: "101 Machine", label: "101 Machine", properties: {}, source: "s" }, {});
  const co = r.entities.find((e) => e.type === "company" && e.value === "101 Machine");
  expect(co).toBeTruthy();
  expect(co?.properties.employees).toBe("3");
  expect(co?.properties.phone).toBe("919-650-3795");
  expect(co?.properties.industries).toContain("Aerospace");
  const loc = r.entities.find((e) => e.type === "location");
  expect(loc?.value).toContain("1937 Evans Rd");
  expect(loc?.lat).toBeCloseTo(35.819162, 4);
  expect(loc?.lon).toBeCloseTo(-78.803482, 4);
  expect(loc?.properties.city).toBe("Cary");
  expect(r.links.some((l) => l.label === "located at")).toBe(true);
  const doc = r.entities.find((e) => e.type === "document");
  expect(doc?.label).toBe("ISO 9001 Certificate");
  expect(r.links.some((l) => l.label === "certified")).toBe(true);
  expect(r.note).toContain("1 SUDOKN manufacturers");
});

test("company-sudokn: no matches → empty, not failed", async () => {
  stubFetch(() => ({ results: { bindings: [] } }));
  const t = (await findTransform("company-sudokn"))!;
  const r = await t.run({ id: "company:zz", type: "company", value: "Nonexistent Corp XYZ", label: "x", properties: {}, source: "s" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/0 SUDOKN/);
});

// ---------- company-traderegister (fixtures mirror the live API shapes:
// search page + company envelope from traderegister.fi, Officer objects
// from its OpenAPI schema; live officers came back empty for every
// company sampled 2026-11-05, so the officer mapping is schema-verified,
// not live-verified) ----------

function traderegisterStub(officersFail = false) {
  return stubFetch((url) => {
    if (url.includes("/v1/search")) {
      return {
        object: "list", query: "Acme", address_countries: [], data: [
          { id: "co_acme1", object: "company", lifecycle: { status: "active" }, name: "Acme Oy", country_code: "FI", company_status: "active", legal_form: "Osakeyhtiö", industry: "Software", business_model: "Software", operating_geography: "Uusimaa, Finland", as_of_date: "2026-10-22" },
          { id: "co_acme2", object: "company", lifecycle: { status: "active" }, name: "Acme AB", country_code: "SE", company_status: "active", legal_form: "Aktiebolag", industry: "Retail", as_of_date: "2026-10-20" },
        ], next_cursor: null, attribution: "Powered by Coragrid",
      };
    }
    if (url.includes("/officers")) {
      if (officersFail) throw new Error("officers down");
      if (url.includes("co_acme1")) {
        return {
          object: "company_officer_list", requested_company_id: "co_acme1", company_id: "co_acme1", data: [
            { object: "company_officer", name: "Aino Example", roles: ["Chief Executive Officer"], appointed_on: "2020-03-02", source: { system: "official_company_register", url: "https://example.invalid/register", observed_at: "2026-10-22T08:00:00Z" } },
            { object: "company_officer", name: "Acme Holdings Ltd", roles: ["Board Member"], source: { system: "official_company_register" } },
          ], has_more: false, attribution: "Powered by Coragrid",
        };
      }
      return { object: "company_officer_list", requested_company_id: "co_acme2", company_id: "co_acme2", data: [], has_more: false, attribution: "Powered by Coragrid" };
    }
    if (url.includes("co_acme1")) {
      return { data: { id: "co_acme1", object: "company", lifecycle: { status: "active" }, name: "Acme Oy", summary: "Acme Oy", country_code: "FI", company_status: "active", company_type: "private_limited_company", legal_form: "Osakeyhtiö", branch: false, industry: "Software", business_model: "Software", operating_geography: "Uusimaa, Finland", as_of_date: "2026-10-22", identifiers: [{ scheme: "national_registry_number", value: "1234567-8", country_scope: "FI", role: "root", status: "active" }], classifications: [{ scheme: "tol_2025", code: "62010", label: "Computer programming", is_primary: true }] }, attribution: "Powered by Coragrid" };
    }
    // co_acme2 profile: bare search-row shape (no data envelope) — exercises the fallback path
    return { id: "co_acme2", object: "company", lifecycle: { status: "active" }, name: "Acme AB", country_code: "SE", company_status: "active", legal_form: "Aktiebolag", industry: "Retail", as_of_date: "2026-10-20" };
  });
}

const traderegisterSeed = { id: "company:acme", type: "company", value: "Acme", label: "Acme", properties: {}, source: "s" } as const;

test("company-traderegister: companies + officers with attribution", async () => {
  traderegisterStub();
  const t = (await findTransform("company-traderegister"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...traderegisterSeed }, {});
  const oy = r.entities.find((e) => e.type === "company" && e.value === "Acme Oy");
  expect(oy).toBeTruthy();
  expect(oy?.properties.status).toBe("active");
  expect(oy?.properties.legal_form).toBe("Osakeyhtiö");
  expect(oy?.properties.country).toBe("FI");
  expect(oy?.properties.registry_id).toBe("1234567-8");
  expect(oy?.properties.industry).toBe("Software");
  expect(oy?.properties.registry_data_as_of).toBe("2026-10-22");
  expect(oy?.properties.via).toMatch(/Powered by Coragrid/);
  expect(oy?.url).toContain("api.traderegister.fi/v1/companies/co_acme1");
  const ab = r.entities.find((e) => e.type === "company" && e.value === "Acme AB");
  expect(ab?.properties.country).toBe("SE"); // search-row fallback, no profile envelope
  const ceo = r.entities.find((e) => e.type === "person" && e.value === "Aino Example");
  expect(ceo).toBeTruthy();
  expect(ceo?.properties.roles).toBe("Chief Executive Officer");
  expect(ceo?.properties.appointed_on).toBe("2020-03-02");
  expect(ceo?.properties.officer_source).toBe("official_company_register");
  expect(ceo?.properties.via).toMatch(/Powered by Coragrid/);
  expect(r.links.find((l) => l.to === ceo!.id)?.label).toBe("officer (Chief Executive Officer)");
  const holdings = r.entities.find((e) => e.value === "Acme Holdings Ltd");
  expect(holdings?.type).toBe("company"); // org-like officer name → company entity
  expect(r.links.find((l) => l.to === oy!.id)?.label).toBe("registered as");
  expect(r.note).toBe("2 companies, 2 officers");
});

test("company-traderegister: no matches → empty, not failed", async () => {
  stubFetch((url) => {
    expect(url).toContain("/v1/search");
    return { object: "list", query: "Zzznothing", data: [], next_cursor: null, attribution: "Powered by Coragrid" };
  });
  const t = (await findTransform("company-traderegister"))!;
  const r = await t.run({ ...traderegisterSeed, value: "Zzznothing Corp" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no trade register matches/);
});

test("company-traderegister: short query → graceful empty (API needs 3+ chars)", async () => {
  stubFetch(() => { throw new Error("should not fetch for a short query"); });
  const t = (await findTransform("company-traderegister"))!;
  const r = await t.run({ ...traderegisterSeed, value: "AB" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/too short/);
});

test("company-traderegister: officers endpoint down → companies still returned", async () => {
  traderegisterStub(true);
  const t = (await findTransform("company-traderegister"))!;
  const r = await t.run({ ...traderegisterSeed }, {});
  expect(r.entities.some((e) => e.type === "company" && e.value === "Acme Oy")).toBe(true);
  expect(r.entities.filter((e) => e.type === "person").length).toBe(0);
  expect(r.note).toBe("2 companies, 0 officers");
});

test("company-traderegister: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("company-traderegister"))!;
  const r = await t.run({ ...traderegisterSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

// ---------- company-opencograph + domain-opencograph (fixtures mirror the
// live API shapes verified 2026-11-11: search results, company detail with
// domains[] + source/licence, domain lookup results) ----------

function ocgStub(detailFail: "none" | "gb" | "all" = "gb") {
  return stubFetch((url) => {
    if (url.includes("/api/v1/search")) {
      return {
        query: "Acme", country: null, limit: 5, count: 2, results: [
          { id: "NO-ORG-123456789", name: "ACME ASA", country: "NO", city: "OSLO", status: "Active", url: "https://graph.locaihost.org/c/no/NO-ORG-123456789-acme-asa", indexed: true },
          { id: "GB-COH-00012345", name: "ACME LTD", country: "GB", city: "LONDON", status: "Active", url: "https://graph.locaihost.org/c/gb/GB-COH-00012345-acme-ltd", indexed: true },
        ],
      };
    }
    if (url.includes("/api/v1/domain")) {
      return {
        domain: "acme.com", results: [
          { id: "NO-ORG-123456789", name: "ACME ASA", country: "NO", status: "Active", confidence: 0.97, method: "registry-stated-website" },
          { id: "GB-COH-00012345", name: "ACME LTD", country: "GB", status: "Active", confidence: 0.9, method: "wikidata-official-website" },
        ],
      };
    }
    if (url.includes("/api/v1/company/NO-ORG-123456789")) {
      if (detailFail === "all") throw new Error("detail down");
      return {
        id: "NO-ORG-123456789", name: "ACME ASA", scheme: "NO-ORG", number: "123456789", country: "NO",
        city: "OSLO", postcode: "0150", status: "Active", legal_form: "ASA", incorporated: "1980-01-15",
        industry: { system: "SN2007 (NACE)", codes: ["06.100"], text: "Utvinning av råolje" },
        previous_name: null, lei: "OW6OFBNCKXC4US5C7523",
        registry_ids: [{ id: "LEI-OW6OFBNCKXC4US5C7523", scheme: "LEI", number: "OW6OFBNCKXC4US5C7523", method: "gleif-registration-authority", confidence: 0.99 }],
        domains: [
          { domain: "acme.com", confidence: 0.97, evidence: [{ method: "registry-stated-website", confidence: 0.97, page: null, note: "Brønnøysund register: hjemmeside" }, { method: "wikidata-official-website", confidence: 0.9, page: "https://www.wikidata.org/wiki/Q1", note: null, wikidata: "Q1" }] },
          { domain: "acme.no", confidence: 0.9, evidence: [{ method: "wikidata-official-website", confidence: 0.9, page: "https://www.wikidata.org/wiki/Q1", note: null, wikidata: "Q1" }] },
        ],
        employees: 1200,
        source: { name: "no-brreg", registry: "Brønnøysund Register Centre (Enhetsregisteret)", licence: "Norwegian Licence for Open Government Data (NLOD) 2.0", licence_url: "https://data.norge.no/nlod/en/2.0", record_url: "https://virksomhet.brreg.no/nb/oppslag/enheter/123456789" },
        url: "https://graph.locaihost.org/c/no/NO-ORG-123456789-acme-asa",
      };
    }
    // GB detail fails in the default stub — exercises the search-row fallback.
    throw new Error("detail down");
  });
}

const ocgCompanySeed = { id: "company:acme", type: "company", value: "Acme", label: "Acme", properties: {}, source: "s" } as const;
const ocgDomainSeed = { id: "domain:acme-com", type: "domain", value: "acme.com", label: "acme.com", properties: {}, source: "s" } as const;

test("company-opencograph: companies + websites with attribution", async () => {
  ocgStub();
  const t = (await findTransform("company-opencograph"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...ocgCompanySeed }, {});
  const asa = r.entities.find((e) => e.type === "company" && e.value === "ACME ASA");
  expect(asa).toBeTruthy();
  expect(asa?.properties.status).toBe("Active");
  expect(asa?.properties.legal_form).toBe("ASA");
  expect(asa?.properties.country).toBe("NO");
  expect(asa?.properties.city).toBe("OSLO");
  expect(asa?.properties.postcode).toBe("0150");
  expect(asa?.properties.lei).toBe("OW6OFBNCKXC4US5C7523");
  expect(asa?.properties.registry_id).toBe("123456789");
  expect(asa?.properties.industry).toBe("06.100 — Utvinning av råolje");
  expect(asa?.properties.incorporated).toBe("1980-01-15");
  expect(asa?.properties.employees).toBe("1200");
  expect(asa?.properties.via).toMatch(/Open Company Graph/);
  expect(asa?.url).toContain("virksomhet.brreg.no"); // registry record wins over graph page
  const ltd = r.entities.find((e) => e.type === "company" && e.value === "ACME LTD");
  expect(ltd?.properties.country).toBe("GB"); // search-row fallback, no detail
  expect(ltd?.url).toContain("graph.locaihost.org/c/gb/");
  const site = r.entities.find((e) => e.type === "domain" && e.value === "acme.com");
  expect(site).toBeTruthy();
  expect(site?.properties.confidence).toBe("0.97");
  expect(site?.properties.website_evidence).toMatch(/registry-stated-website/);
  expect(site?.properties.via).toMatch(/Open Company Graph/);
  expect(site?.url).toBe("https://acme.com");
  expect(r.links.find((l) => l.to === asa!.id)?.label).toBe("registered as");
  expect(r.links.find((l) => l.to === site!.id)?.label).toBe("website");
  expect(r.note).toBe("2 companies, 2 websites");
});

test("company-opencograph: no matches → empty, not failed", async () => {
  stubFetch((url) => {
    expect(url).toContain("/api/v1/search");
    return { query: "Zzznothing", country: null, limit: 5, count: 0, results: [] };
  });
  const t = (await findTransform("company-opencograph"))!;
  const r = await t.run({ ...ocgCompanySeed, value: "Zzznothing Corp" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no Open Company Graph matches/);
});

test("company-opencograph: short query → graceful empty (API needs 3+ chars)", async () => {
  stubFetch(() => { throw new Error("should not fetch for a short query"); });
  const t = (await findTransform("company-opencograph"))!;
  const r = await t.run({ ...ocgCompanySeed, value: "AB" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/too short/);
});

test("company-opencograph: detail down → companies still returned, no websites", async () => {
  ocgStub("all");
  const t = (await findTransform("company-opencograph"))!;
  const r = await t.run({ ...ocgCompanySeed }, {});
  expect(r.entities.some((e) => e.type === "company" && e.value === "ACME ASA")).toBe(true);
  expect(r.entities.filter((e) => e.type === "domain").length).toBe(0);
  expect(r.note).toBe("2 companies, 0 websites");
});

test("company-opencograph: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("company-opencograph"))!;
  const r = await t.run({ ...ocgCompanySeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

test("domain-opencograph: companies behind the domain, owned-by links", async () => {
  ocgStub();
  const t = (await findTransform("domain-opencograph"))!;
  expect(t.inputTypes).toContain("domain");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...ocgDomainSeed }, {});
  const asa = r.entities.find((e) => e.type === "company" && e.value === "ACME ASA");
  expect(asa).toBeTruthy();
  expect(asa?.properties.country).toBe("NO");
  expect(asa?.properties.status).toBe("Active");
  expect(asa?.properties.domain_confidence).toBe("0.97");
  expect(asa?.properties.website_evidence).toBe("registry-stated-website");
  expect(asa?.properties.legal_form).toBe("ASA"); // detail enriched the row
  expect(asa?.properties.via).toMatch(/Open Company Graph/);
  expect(r.links.find((l) => l.to === asa!.id)?.label).toBe("owned by");
  const ltd = r.entities.find((e) => e.type === "company" && e.value === "ACME LTD");
  expect(ltd?.properties.domain_confidence).toBe("0.9");
  expect(r.note).toBe("2 companies behind this domain");
});

test("domain-opencograph: not a domain → graceful empty, no fetch", async () => {
  stubFetch(() => { throw new Error("should not fetch for a non-domain"); });
  const t = (await findTransform("domain-opencograph"))!;
  const r = await t.run({ ...ocgDomainSeed, value: "notadomain" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/not a domain/);
});

test("domain-opencograph: no matches → empty, not failed", async () => {
  stubFetch((url) => {
    expect(url).toContain("/api/v1/domain");
    return { domain: "nothing.example", results: [] };
  });
  const t = (await findTransform("domain-opencograph"))!;
  const r = await t.run({ ...ocgDomainSeed, value: "nothing.example" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no companies behind this domain/);
});

test("ip-risk: verdict behind evidence_state, as + location entities", async () => {
  stubFetch((url) => {
    expect(url).toContain("ip99.com/v1/ip/");
    return {
      ip: "1.2.3.4", computed_at: "2026-10-16T12:00:00Z", evidence_state: "active",
      risk: { score: 72, level: "high", signals: ["proxy", "vpn", "hosting"] },
      network: { asn: 12345, usage_type: "ISP" },
      geo: { city: "Lagos", region: "Lagos", country: "NG", lat: 6.5, lon: 3.4, tz: "Africa/Lagos" },
    };
  });
  const t = (await findTransform("ip-risk"))!;
  expect(t.inputTypes).toContain("ip");
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ id: "ip:1-2-3-4", type: "ip", value: "1.2.3.4", label: "1.2.3.4", properties: {}, source: "s" }, {});
  const ip = r.entities.find((e) => e.type === "ip");
  expect(ip?.properties.risk).toBe("72 (high)");
  expect(ip?.properties.evidence).toBe("active");
  expect(ip?.properties.signals).toContain("proxy");
  expect(ip?.properties.freshness).toMatch(/point-in-time/);
  const as = r.entities.find((e) => e.type === "as");
  expect(as?.value).toBe("AS12345");
  expect(r.links.find((l) => l.to === as!.id)?.label).toBe("announced by");
  const loc = r.entities.find((e) => e.type === "location");
  expect(loc?.value).toContain("Lagos");
  expect(loc?.lat).toBeCloseTo(6.5, 4);
  expect(r.links.some((l) => l.label === "geolocated to")).toBe(true);
  expect(r.note).toMatch(/risk 72 \(high\) \u2014 active/);
});

test("ip-risk: 429 → quota note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("ip-risk"))!;
  const r = await t.run({ id: "ip:1-2-3-4", type: "ip", value: "1.2.3.4", label: "1.2.3.4", properties: {}, source: "s" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/quota exhausted/);
});

test("domain-footprint: dns + certs + same-cert siblings", async () => {
  const FP = "85ca6ab068e9bcce88b6c4aa3c47f7d17228134a457f870d3800e6223a0df07a";
  stubFetch((url) => {
    if (url.includes("/v1/domain/dns/")) {
      return { count: 2, data: [
        { first_seen: "2025-04-10", last_seen: "2025-04-10", rrtype: "A", value: "93.184.216.34" },
        { first_seen: "2025-04-10", last_seen: "2025-04-10", rrtype: "CNAME", value: "alias.example.com." },
      ] };
    }
    if (url.includes("/v1/domain/certs/")) {
      return { count: 1, data: [{ fingerprint: FP, issuer_org: "SSL Corp", log_source: "test-log", not_before: "2026-09-26 22:49:11", wildcard: false }] };
    }
    if (url.includes("/v1/domain/fingerprint/")) {
      expect(url).toContain(FP);
      return { count: 2, data: [
        { domain: "example.com", first_seen: "2026-09-26", last_seen: "2026-09-26", wildcard: false },
        { domain: "evil.example.net", first_seen: "2026-09-27", last_seen: "2026-09-28", wildcard: false },
      ] };
    }
    throw new Error("unexpected url " + url);
  });
  const t = (await findTransform("domain-footprint"))!;
  expect(t.inputTypes).toContain("domain");
  const r = await t.run({ id: "domain:example-com", type: "domain", value: "example.com", label: "e", properties: {}, source: "s" }, {});
  const ip = r.entities.find((e) => e.type === "ip");
  expect(ip?.value).toBe("93.184.216.34");
  expect(r.links.find((l) => l.to === ip!.id)?.label).toBe("resolved to");
  const doc = r.entities.find((e) => e.type === "document");
  expect(doc?.properties.issuer).toBe("SSL Corp");
  expect(r.links.find((l) => l.to === doc!.id)?.label).toBe("issued cert");
  const sib = r.entities.find((e) => e.type === "domain" && e.value === "evil.example.net");
  expect(sib).toBeTruthy();
  expect(r.links.find((l) => l.to === sib!.id)?.label).toBe("shares cert with");
  expect(r.note).toMatch(/1 resolved IPs/);
});

// ---------- wikimedia-geo (local SQLite fixture, no download needed) ----------

function buildWgeoFixture(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "wgeo-"));
  const dbPath = join(dir, "wgeo.db");
  const db = new Database(dbPath, { create: true });
  db.exec(`CREATE TABLE places(
    qid TEXT PRIMARY KEY, label TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
    qrank REAL, url TEXT, cell INTEGER NOT NULL);
    CREATE INDEX idx_cell_qrank ON places(cell, qrank DESC);`);
  const cell = (lat: number, lon: number) => (Math.floor(lat) + 90) * 360 + (Math.floor(lon) + 180);
  const ins = db.query(`INSERT INTO places(qid,label,lat,lon,qrank,url,cell) VALUES (?,?,?,?,?,?,?)`);
  ins.run("Q90", "Paris", 48.8566, 2.3522, 999.0, "https://www.wikidata.org/wiki/Q90", cell(48.8566, 2.3522));
  ins.run("Q12345", "Eiffel Tower", 48.8584, 2.2945, 900.0, "https://www.wikidata.org/wiki/Q12345", cell(48.8584, 2.2945));
  ins.run("Q99999", "Far Away Place", 0.0, 0.0, 950.0, null, cell(0, 0)); // outside 50 km
  db.close();
  return { dir, dbPath };
}

test("wikimedia-geo: fixture index → QRank-ranked places, haversine-filtered", async () => {
  const { dir, dbPath } = buildWgeoFixture();
  const prev = process.env.MERIDIAN_WIKIMEDIA_DB;
  process.env.MERIDIAN_WIKIMEDIA_DB = dbPath;
  try {
    const t = (await findTransform("wikimedia-geo"))!;
    expect(t.inputTypes).toContain("location");
    expect(t.needsKey).toBeUndefined();
    const r = await t.run(
      { id: "location:paris", type: "location", value: "Paris", label: "Paris", properties: {}, source: "s", lat: 48.8566, lon: 2.3522 }, {});
    expect(r.entities.length).toBe(2); // far-away place filtered by haversine
    expect(r.entities[0].value).toBe("Paris"); // qrank 999 first
    expect(r.entities[1].value).toBe("Eiffel Tower");
    expect(r.entities[0].type).toBe("location");
    expect(r.entities[0].id).toBe("location:q90"); // deterministic per-QID id
    expect(r.entities[0].properties.qid).toBe("Q90");
    expect(r.entities[0].properties.qrank).toBe("999");
    expect(r.entities[0].url).toBe("https://www.wikidata.org/wiki/Q90");
    expect(r.entities[0].lat).toBeCloseTo(48.8566, 4);
    expect(r.links.every((l) => l.label === "notable nearby")).toBe(true);
    expect(r.links[0].from).toBe("location:paris");
    expect(r.note).toMatch(/2 notable places/);
    // location without coordinates → graceful note
    const r2 = await t.run(
      { id: "location:x", type: "location", value: "X", label: "X", properties: {}, source: "s" }, {});
    expect(r2.entities).toEqual([]);
    expect(r2.note).toMatch(/no coordinates/);
  } finally {
    if (prev === undefined) delete process.env.MERIDIAN_WIKIMEDIA_DB;
    else process.env.MERIDIAN_WIKIMEDIA_DB = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wikimedia-geo: no index configured → clear note, no throw", async () => {
  const prev = process.env.MERIDIAN_WIKIMEDIA_DB;
  delete process.env.MERIDIAN_WIKIMEDIA_DB;
  try {
    const t = (await findTransform("wikimedia-geo"))!;
    const r = await t.run(
      { id: "location:paris", type: "location", value: "Paris", label: "Paris", properties: {}, source: "s", lat: 48.85, lon: 2.35 }, {});
    expect(r.entities).toEqual([]);
    expect(r.note).toMatch(/not configured/);
  } finally {
    if (prev !== undefined) process.env.MERIDIAN_WIKIMEDIA_DB = prev;
  }
});

// ---------- company-companyregistry (fixtures mirror the live API shapes
// verified 2026-11-26: search page with company_status as an OBJECT,
// company detail envelope, officer list; EQUINOR A S proves
// lifecycle.status is NOT the company status) ----------

function companyregistryStub(officersFail = false) {
  return stubFetch((url) => {
    if (url.includes("/v1/search")) {
      return {
        object: "list", query: "Equinor", address_countries: [], data: [
          { id: "co_0eatqyewfztbxjc669y5xh49rg", object: "company", lifecycle: { status: "active" }, name: "EQUINOR 1, s.r.o.", summary: "EQUINOR 1, s.r.o.", country_code: "CZ", company_status: { category: "active" }, legal_form: "Společnost s ručením omezeným", branch: false, industry: "Pronájem a správa vlastních nebo pronajatých nemovitostí", operating_geography: "Jihomoravský kraj, Czechia", as_of_date: "2026-11-23" },
          { id: "co_6npv0wdebznth5sz8266f70jbj", object: "company", lifecycle: { status: "active" }, name: "EQUINOR A S", summary: "EQUINOR A S", country_code: "NO", company_status: { local_name: "Ceased", category: "inactive" }, legal_form: "Société commerciale étrangère immatriculée au RCS", branch: false, operating_geography: "Norway", as_of_date: "2026-10-07" },
        ], next_cursor: null, attribution: "Powered by Coragrid",
      };
    }
    if (url.includes("/officers")) {
      if (officersFail) throw new Error("officers down");
      if (url.includes("co_0eatqyewfztbxjc669y5xh49rg")) {
        return {
          object: "company_officer_list", requested_company_id: "co_0eatqyewfztbxjc669y5xh49rg", company_id: "co_0eatqyewfztbxjc669y5xh49rg", data: [
            { object: "company_officer", name: "NORBERT HRABALÍK", roles: ["Jednatel"], appointed_on: "2025-06-23", source: { system: "ares", url: "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty-vr/23417153", title: "ARES VR record for IČO 23417153", observed_at: "2026-11-23T14:26:26.131226Z" } },
            { object: "company_officer", name: "Equinor Holdings Ltd", roles: ["Board Member"], source: { system: "ares" } },
          ], has_more: false, attribution: "Powered by Coragrid",
        };
      }
      return { object: "company_officer_list", requested_company_id: "co_6npv0wdebznth5sz8266f70jbj", company_id: "co_6npv0wdebznth5sz8266f70jbj", data: [], has_more: false, attribution: "Powered by Coragrid" };
    }
    if (url.includes("co_0eatqyewfztbxjc669y5xh49rg")) {
      return { data: { id: "co_0eatqyewfztbxjc669y5xh49rg", object: "company", lifecycle: { status: "active" }, name: "EQUINOR 1, s.r.o.", summary: "EQUINOR 1, s.r.o.", country_code: "CZ", company_status: { category: "active" }, legal_form: "Společnost s ručením omezeným", branch: false, industry: "Pronájem a správa vlastních nebo pronajatých nemovitostí", operating_geography: "Jihomoravský kraj, Czechia", as_of_date: "2026-11-23", identifiers: [{ scheme: "national_registry_number", value: "23417153", country_scope: "CZ", role: "root", status: "active" }] }, attribution: "Powered by Coragrid" };
    }
    // co_6npv detail: empty body — exercises the search-row fallback path
    return {};
  });
}

const companyregistrySeed = { id: "company:equinor", type: "company", value: "Equinor", label: "Equinor", properties: {}, source: "s" } as const;

test("company-companyregistry: companies + officers with attribution", async () => {
  companyregistryStub();
  const t = (await findTransform("company-companyregistry"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...companyregistrySeed }, {});
  const cz = r.entities.find((e) => e.type === "company" && e.value === "EQUINOR 1, s.r.o.");
  expect(cz).toBeTruthy();
  expect(cz?.properties.status).toBe("active");
  expect(cz?.properties.legal_form).toBe("Společnost s ručením omezeným");
  expect(cz?.properties.country).toBe("CZ");
  expect(cz?.properties.registry_id).toBe("23417153");
  expect(cz?.properties.industry).toContain("Pronájem");
  expect(cz?.properties.geography).toBe("Jihomoravský kraj, Czechia");
  expect(cz?.properties.registry_data_as_of).toBe("2026-11-23");
  expect(cz?.properties.via).toMatch(/Powered by Coragrid/);
  expect(cz?.url).toContain("api.companyregistryapi.com/v1/companies/co_0eatqyewfztbxjc669y5xh49rg");
  // lifecycle.status is "active" for this one too — but the status must
  // come from company_status.category, so the ceased NO company is inactive
  const no = r.entities.find((e) => e.type === "company" && e.value === "EQUINOR A S");
  expect(no?.properties.status).toBe("inactive");
  expect(no?.properties.country).toBe("NO"); // search-row fallback, no profile envelope
  const officer = r.entities.find((e) => e.type === "person" && e.value === "NORBERT HRABALÍK");
  expect(officer).toBeTruthy();
  expect(officer?.properties.roles).toBe("Jednatel");
  expect(officer?.properties.appointed_on).toBe("2025-06-23");
  expect(officer?.properties.officer_source).toBe("ares");
  expect(officer?.properties.observed_at).toBe("2026-11-23T14:26:26");
  expect(officer?.properties.via).toMatch(/Powered by Coragrid/);
  expect(r.links.find((l) => l.to === officer!.id)?.label).toBe("officer (Jednatel)");
  const holdings = r.entities.find((e) => e.value === "Equinor Holdings Ltd");
  expect(holdings?.type).toBe("company"); // org-like officer name → company entity
  expect(r.links.find((l) => l.to === cz!.id)?.label).toBe("registered as");
  expect(r.note).toBe("2 companies, 2 officers");
});

test("company-companyregistry: no matches → empty, not failed", async () => {
  stubFetch((url) => {
    expect(url).toContain("/v1/search");
    return { object: "list", query: "Zzznothing", data: [], next_cursor: null, attribution: "Powered by Coragrid" };
  });
  const t = (await findTransform("company-companyregistry"))!;
  const r = await t.run({ ...companyregistrySeed, value: "Zzznothing Corp" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no CompanyRegistryAPI.com matches/);
});

test("company-companyregistry: short query → graceful empty (min 3 chars)", async () => {
  stubFetch(() => { throw new Error("should not fetch for a short query"); });
  const t = (await findTransform("company-companyregistry"))!;
  const r = await t.run({ ...companyregistrySeed, value: "AB" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/too short/);
});

test("company-companyregistry: officers endpoint down → companies still returned", async () => {
  companyregistryStub(true);
  const t = (await findTransform("company-companyregistry"))!;
  const r = await t.run({ ...companyregistrySeed }, {});
  expect(r.entities.some((e) => e.type === "company" && e.value === "EQUINOR 1, s.r.o.")).toBe(true);
  expect(r.entities.filter((e) => e.type === "person").length).toBe(0);
  expect(r.note).toBe("2 companies, 0 officers");
});

test("company-companyregistry: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("company-companyregistry"))!;
  const r = await t.run({ ...companyregistrySeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

// ---------- company-wsystem (fixtures mirror the live API shapes verified
// 2026-11-26: a FR national-register row and a GLEIF LEI-fallback row from
// api.wsystem.dev/company; no lat/lon fields exist in either) ----------

function wsystemStub() {
  return stubFetch((url) => {
    expect(url).toContain("api.wsystem.dev/company");
    if (url.includes("Zzznothing")) {
      return { query: "Zzznothing", country: null, status: "not_found", count: 0, results: [], error: null, coverage: { scope: "lei_holders_only", label: "LEI holders only", source: "GLEIF LEI index", note: "Searched the GLEIF LEI index: only legal entities that hold an LEI are covered; companies without an LEI are not found here." } };
    }
    return {
      query: "DANONE", country: null, status: "found", count: 2, results: [
        { country: "FR", registry_id: "552032534", name: "DANONE", legal_form: "5599", status: "A", active: true, address: "59-61 RUE LA FAYETTE 75009 PARIS", postal_code: "75009", city: "PARIS", registration_date: "1955-01-01", vat_id: "FR27552032534", activity_code: "70.10Z", activity: null, website: null, employees: "42", lei: null, source: "INSEE Sirene / recherche-entreprises.api.gouv.fr", source_url: "https://annuaire-entreprises.data.gouv.fr/entreprise/552032534", status_normalized: "active", status_raw: { etat_administratif: "A", date_fermeture: null }, company_category: "GE", establishments: 3, financial_year: 2025, revenue_eur: 27376000000, net_income_eur: 2100000000, register_updated_at: "2026-11-26T09:32:57", data_source: "live", retrieved_at: "2026-11-26T14:41:26Z", data_as_of: "2026-11-26T14:41:26Z", origin: "national_register", status_source: "national_register", served_from: "upstream", cache_age_seconds: 0, match: { type: "exact", score: 100 } },
        { country: "ES", registry_id: "A17000852", name: "DANONE SA", legal_form: "5RDO", status: "ACTIVE", active: null, address: "CALLE BUENOS AIRES 21", postal_code: "08029", city: "BARCELONA", registration_date: "2014-02-08T00:00:00Z", vat_id: null, activity_code: null, activity: null, website: null, employees: "NN", lei: "213800S18Y5XNF6TLB35", source: "GLEIF Global LEI Index (api.gleif.org)", source_url: "https://search.gleif.org/#/record/213800S18Y5XNF6TLB35", status_normalized: "unknown", status_raw: { entity_status: "ACTIVE", registration_status: "ISSUED" }, status_source: "lei_index", lei_status: "ACTIVE", data_source: "live", retrieved_at: "2026-11-26T14:41:27Z", data_as_of: "2026-11-26T14:41:27Z", origin: "lei_index", served_from: "upstream", cache_age_seconds: 0, match: { type: "exact", score: 100 } },
      ],
    };
  });
}

const wsystemSeed = { id: "company:danone", type: "company", value: "Danone", label: "Danone", properties: {}, source: "s" } as const;

test("company-wsystem: companies + street addresses, LEI status flagged", async () => {
  wsystemStub();
  const t = (await findTransform("company-wsystem"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...wsystemSeed }, {});
  const fr = r.entities.find((e) => e.type === "company" && e.value === "DANONE");
  expect(fr).toBeTruthy();
  expect(fr?.properties.status).toBe("active");
  expect(fr?.properties.country).toBe("FR");
  expect(fr?.properties.registry_id).toBe("552032534");
  expect(fr?.properties.legal_form_code).toBe("5599");
  expect(fr?.properties.vat_id).toBe("FR27552032534");
  expect(fr?.properties.activity_code).toBe("70.10Z");
  expect(fr?.properties.employees).toBe("42");
  expect(fr?.properties.registered_on).toBe("1955-01-01");
  expect(fr?.properties.revenue_eur).toBe("27376000000");
  expect(fr?.properties.via).toMatch(/W System/);
  expect(fr?.url).toContain("annuaire-entreprises.data.gouv.fr/entreprise/552032534");
  const es = r.entities.find((e) => e.type === "company" && e.value === "DANONE SA");
  expect(es?.properties.status).toBe("unknown");
  expect(es?.properties.status_source).toMatch(/LEI status, not register status/);
  expect(es?.properties.lei).toBe("213800S18Y5XNF6TLB35");
  expect(es?.properties.employees).toBeUndefined(); // "NN" sentinel skipped
  const paris = r.entities.find((e) => e.type === "location" && e.value === "59-61 RUE LA FAYETTE 75009 PARIS");
  expect(paris).toBeTruthy();
  expect(paris?.properties.city).toBe("PARIS");
  expect(paris?.properties.postal).toBe("75009");
  expect(paris?.lat).toBeUndefined(); // API returns no coordinates
  expect(r.links.find((l) => l.to === paris!.id)?.label).toBe("located at");
  const bcn = r.entities.find((e) => e.type === "location" && e.value === "CALLE BUENOS AIRES 21");
  expect(bcn?.properties.city).toBe("BARCELONA");
  expect(r.links.find((l) => l.to === fr!.id)?.label).toBe("registered as");
  expect(r.note).toBe("2 companies, 2 addresses");
});

test("company-wsystem: no matches → empty, LEI-only coverage noted", async () => {
  wsystemStub();
  const t = (await findTransform("company-wsystem"))!;
  const r = await t.run({ ...wsystemSeed, value: "Zzznothing Corp" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no W System matches/);
  expect(r.note).toMatch(/LEI holders only/);
});

test("company-wsystem: short query → graceful empty (min 3 chars)", async () => {
  stubFetch(() => { throw new Error("should not fetch for a short query"); });
  const t = (await findTransform("company-wsystem"))!;
  const r = await t.run({ ...wsystemSeed, value: "AB" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/too short/);
});

test("company-wsystem: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("company-wsystem"))!;
  const r = await t.run({ ...wsystemSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

// ---------- company-regbase (fixture mirrors the LIVE signed Toyota record
// from regbase.local-connect-design.trade/record/1180301018771, 2026-11-26;
// /openapi.json confirms no name-search endpoint exists) ----------

const regbaseRecord = {
  record_version: "1.0", record_type: "regbase-record/1",
  subject: { corporate_number: "1180301018771" },
  claims: [
    { field: "company_name", value: "トヨタ自動車株式会社", source: "EDINET code list (listed_codes_detail.csv)", as_of: "2026-11-07" },
    { field: "listed_status", value: "Listed company", source: "EDINET code list (listed_codes_detail.csv)", as_of: "2026-11-07" },
    { field: "securities_code", value: "72030", source: "EDINET code list (listed_codes_detail.csv)", as_of: "2026-11-07" },
    { field: "edinet_code", value: "E02144", source: "EDINET code list (listed_codes_detail.csv)", as_of: "2026-11-07" },
  ],
  issued_at: "2026-11-26T14:41:29Z", issuer: "RegBase T3 sandbox",
  signature: { algorithm: "Ed25519", key_id: "9f01575a05050b62", signature: "jgc3liMPiHaSqULVtvTnzzjKYPhcOEPi7lLX1EuZi7KfGTobxX3bxYX62h7deQo2FxMmo1xDgOM4MrWellXaAA==" },
};

const regbaseSeed = { id: "company:1180301018771", type: "company", value: "1180301018771", label: "1180301018771", properties: {}, source: "s" } as const;

test("company-regbase: signed record → company entity with claims", async () => {
  stubFetch((url) => {
    expect(url).toBe("https://regbase.local-connect-design.trade/record/1180301018771");
    return regbaseRecord;
  });
  const t = (await findTransform("company-regbase"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...regbaseSeed }, {});
  expect(r.entities.length).toBe(1);
  const co = r.entities[0];
  expect(co.type).toBe("company");
  expect(co.value).toBe("トヨタ自動車株式会社");
  expect(co.properties.corporate_number).toBe("1180301018771");
  expect(co.properties.listed_status).toBe("Listed company");
  expect(co.properties.securities_code).toBe("72030");
  expect(co.properties.edinet_code).toBe("E02144");
  expect(co.properties.issued_at).toBe("2026-11-26T14:41:29Z");
  expect(co.properties.signature).toContain("Ed25519");
  expect(co.properties.signature).toContain("9f01575a05050b62");
  expect(co.properties.via).toMatch(/RegBase/);
  expect(co.url).toBe("https://regbase.local-connect-design.trade/record/1180301018771");
  expect(r.links[0]?.label).toBe("verified as");
  expect(r.note).toMatch(/signed RegBase record/);
});

test("company-regbase: company name instead of a number → instructions, no fetch", async () => {
  stubFetch(() => { throw new Error("should not fetch without a 13-digit number"); });
  const t = (await findTransform("company-regbase"))!;
  const r = await t.run({ ...regbaseSeed, value: "Toyota" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/13-digit/);
  expect(r.note).toMatch(/no name search/);
});

test("company-regbase: unknown number (404) → sandbox-coverage note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: "NOT_FOUND", corporate_number: "9999999999999" }) }) as any;
  const t = (await findTransform("company-regbase"))!;
  const r = await t.run({ ...regbaseSeed, value: "9999999999999" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no RegBase record/);
  expect(r.note).toMatch(/3,808/);
});

test("company-regbase: 429 → daily-cap note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("company-regbase"))!;
  const r = await t.run({ ...regbaseSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/daily cap/);
});

// meridian — batch C tests. SNIPPET FILE ONLY — paste into
// src/transforms.test.ts. Assumes the file's existing stubFetch helper and
// afterAll fetch restore. New helpers below are batch-C-local (distinct
// names, no clash with existing helpers).
//
// Fixtures mirror LIVE API shapes verified 2026-11-26 (see delivery
// report), except wallet-helius, whose fixture mirrors the DOCUMENTED
// TransactionResult shape from the Helius quickstart (keyed — no live
// call possible without a key).

// ---------- batch-C stub helpers (add near the existing stubFetch) ----------

// fetch stub returning plain text (crt.name) instead of JSON.
function stubFetchText(text: string, status = 200) {
  (globalThis as any).fetch = async () => ({
    ok: status >= 200 && status < 300, status, text: async () => text,
  }) as any;
}

// fetch stub that also hands the handler the request options (lets the
// Helius test assert on the POST body + api-key query param).
function stubFetchOpts(handler: (url: string, opts: any) => any) {
  (globalThis as any).fetch = async (url: string | URL, opts?: any) => {
    const body = handler(String(url), opts || {});
    return { ok: true, status: 200, json: async () => body } as any;
  };
}

// ---------- REPLACE the existing entity-types test with this one ----------
// (12 types → 13: wallet added. Do NOT touch the pinned registry-count
// test or EXPECTED_BUSINESS_TRANSFORMS — the coordinator updates those.)

test("entity types: 13 Maltego-style types with icon + color", () => {
  const keys = Object.keys(ENTITY_TYPES);
  expect(keys.length).toBe(13);
  for (const k of keys) {
    const m = ENTITY_TYPES[k as EntityType];
    expect(m.label.length).toBeGreaterThan(0);
    expect(m.icon.length).toBeGreaterThan(0);
    expect(m.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  }
  expect(ENTITY_TYPES.domain.icon).toBe("🌐");
  expect(ENTITY_TYPES.person.color).toBe("#E8A838");
  expect(ENTITY_TYPES.wallet.label).toBe("Wallet");
  expect(ENTITY_TYPES.wallet.icon).toBe("👛");
  expect(ENTITY_TYPES.wallet.color).toBe("#D35400");
});

// ---------- domain-crtname (fixture mirrors the live plain-text shape:
// "name<TAB>first-seen-ISO" lines, verified 2026-11-26 for example.com) ----------

const crtnameSeed = { id: "domain:example-com", type: "domain", value: "example.com", label: "example.com", properties: {}, source: "s" } as const;

test("domain-crtname: parses dated plain-text lines, skips apex + wildcards + dupes", async () => {
  stubFetchText(
    "example.com\t2009-07-03T20:37:11Z\n" +
    "a.example.com\t2009-11-20T15:42:35Z\n" +
    "*.example.com\t2009-11-20T15:42:36Z\n" +
    "b.example.com\t2010-01-01T00:00:00Z\n" +
    "a.example.com\t2009-11-20T15:42:35Z\n" +
    "www.example.com\n",
  );
  const t = (await findTransform("domain-crtname"))!;
  expect(t.inputTypes).toContain("domain");
  expect(t.business).toBe(false);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...crtnameSeed }, {});
  expect(r.entities.map((e) => e.value).sort()).toEqual(["a.example.com", "b.example.com", "www.example.com"]);
  expect(r.entities.every((e) => e.type === "domain")).toBe(true);
  expect(r.entities.find((e) => e.value === "a.example.com")?.properties.first_seen).toBe("2009-11-20");
  expect(r.entities.find((e) => e.value === "www.example.com")?.properties.first_seen).toBeUndefined();
  expect(r.links.every((l) => l.label === "subdomain of")).toBe(true);
  expect(r.links[0].from).toBe("domain:example-com");
  expect(r.note).toMatch(/3 subdomains/);
  expect(r.note).toMatch(/historical/);
});

test("domain-crtname: 429 → rate-limit note, no throw", async () => {
  stubFetchText("", 429);
  const t = (await findTransform("domain-crtname"))!;
  const r = await t.run({ ...crtnameSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

// ---------- ip-vpndetection (fixture is the live 8.8.8.8 response, 2026-11-26) ----------

test("ip-vpndetection: flags + ASN + location entities", async () => {
  stubFetch((url) => {
    expect(url).toBe("https://api.vpndetection.io/8.8.8.8");
    return {
      ip: "8.8.8.8", is_bogon: false, is_vpn: false, is_relay: false, is_tor: false, is_anycast: true,
      relay: {}, tor: {},
      location: { continent: "NA", continent_name: "North America", country: "US", country_name: "United States", timezone: "America/Los_Angeles", currency_code: "USD", currency_name: "Dollar", currency_symbol: "$" },
      asn: { asn: 15169, name: "Google LLC", domain: "google.com", type: "hosting", prefix: "8.8.8.0/24", country: "US", rpki_status: "valid" },
      hostname: "dns.google",
    };
  });
  const t = (await findTransform("ip-vpndetection"))!;
  expect(t.inputTypes).toContain("ip");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ id: "ip:8-8-8-8", type: "ip", value: "8.8.8.8", label: "8.8.8.8", properties: {}, source: "s" }, {});
  const ip = r.entities.find((e) => e.type === "ip");
  expect(ip?.properties.vpn).toBe("no");
  expect(ip?.properties.tor).toBe("no");
  expect(ip?.properties.anycast).toBe("yes");
  expect(ip?.properties.asn).toBe("AS15169");
  expect(ip?.properties.asn_name).toBe("Google LLC");
  expect(ip?.properties.hostname).toBe("dns.google");
  expect(ip?.properties.bot).toBeUndefined(); // anonymous responses carry no is_bot
  const as = r.entities.find((e) => e.type === "as");
  expect(as?.value).toBe("AS15169");
  expect(r.links.find((l) => l.to === as!.id)?.label).toBe("announced by");
  const loc = r.entities.find((e) => e.type === "location");
  expect(loc?.value).toContain("United States");
  expect(loc?.properties.timezone).toBe("America/Los_Angeles");
  expect(r.links.find((l) => l.to === loc!.id)?.label).toBe("located in");
  expect(r.note).toMatch(/no VPN\/Tor\/relay flags/);
});

test("ip-vpndetection: empty body → graceful empty", async () => {
  stubFetch(() => ({}));
  const t = (await findTransform("ip-vpndetection"))!;
  const r = await t.run({ id: "ip:1-2-3-4", type: "ip", value: "1.2.3.4", label: "1.2.3.4", properties: {}, source: "s" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no data/);
});

// ---------- wallet-fills (fixture mirrors the live /v1/fills rows
// for a real wallet, verified 2026-11-26) ----------

const ironflowWallet = "0x01535f0ffbf18d084366c4dc846e58bb915fdd09";
const ironflowSeed = { id: "wallet:0x01535f0ffbf18d084366c4dc846e58bb915fdd09", type: "wallet", value: ironflowWallet, label: ironflowWallet, properties: {}, source: "s" } as const;

test("wallet-fills: wallet fills → document entities with fill facts", async () => {
  stubFetch((url) => {
    expect(url).toContain("/v1/fills?address=0x01535f0ffbf18d084366c4dc846e58bb915fdd09");
    expect(url).toContain("limit=10");
    return {
      data: [
        { source: "hyperliquid", market: "BTC-PERP", timestamp: 1795700512940, block_number: 1235519241, sequence: 1, price: "60826", size: "0.0003", side: "buy", address: ironflowWallet, fee: "0.000437", realized_pnl: "0.00318", hash: "0xe4173d8c20fd0520e5900449a4870901d2005571bbf023f287dfe8dedff0df0b", dir: "Close Short", venue: "hyperliquid", quote_asset: "USDC", display_symbol: "BTC-PERP", notional: "18.2478", oid: 617271957680, tid: 139400543391800, fee_token: "USDC" },
        { source: "hyperliquid", market: "BTC-PERP", timestamp: 1795700593033, block_number: 1235520375, sequence: 26, price: "60856", size: "0.1", side: "sell", address: ironflowWallet, fee: "0.146054", realized_pnl: "0", hash: "0xfdeb3f31db318739ff640449a48b7702017000177634a60ca1b3ea849a356124", dir: "Open Short", venue: "hyperliquid", quote_asset: "USDC", display_symbol: "BTC-PERP", notional: "6085.6", oid: 617272487161, tid: 513657794791297, fee_token: "USDC" },
      ],
      pagination: { next_cursor: "MTc5NTcwMDU5MzAzMy0yNg==", has_more: true },
      credits: { cost: 1, daily: { used: 1, limit: 100, remaining: 99, window: "rolling_24h" } },
    };
  });
  const t = (await findTransform("wallet-fills"))!;
  expect(t.inputTypes).toContain("wallet");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...ironflowSeed }, {});
  expect(r.entities.filter((e) => e.type === "document").length).toBe(2);
  const sell = r.entities.find((e) => e.type === "document" && e.label.startsWith("sell 0.1 BTC-PERP @ 60856"));
  expect(sell).toBeTruthy();
  expect(sell?.properties.market).toBe("BTC-PERP");
  expect(sell?.properties.side).toBe("sell");
  expect(sell?.properties.price).toBe("60856");
  expect(sell?.properties.size).toBe("0.1");
  expect(sell?.properties.address).toBe(ironflowWallet);
  expect(sell?.properties.block).toBe("1235520375");
  expect(sell?.properties.hash).toBe("0xfdeb3f31db318739ff640449a48b7702017000177634a60ca1b3ea849a356124");
  expect(sell?.properties.timestamp).toMatch(/^20\d\d-/);
  expect(r.links.find((l) => l.to === sell!.id)?.label).toBe("filled");
  expect(r.links.find((l) => l.to === sell!.id)?.from).toBe(ironflowSeed.id);
  expect(r.note).toBe("2 Hyperliquid fills (last 24h, keyless)");
});

test("wallet-fills: non-EVM wallet value → graceful empty, no fetch", async () => {
  stubFetch(() => { throw new Error("should not fetch for a non-EVM address"); });
  const t = (await findTransform("wallet-fills"))!;
  const r = await t.run({ ...ironflowSeed, value: "GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/not an Ethereum wallet address/);
});

// ---------- wallet-helius (fixture mirrors the DOCUMENTED TransactionResult
// shape from the Helius quickstart — keyed, so no live call was possible) ----------

const heliusWallet = "GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52";
const heliusSeed = { id: "wallet:gv6uumnxz2rpkxmnapadykb7uqpszwqqau3qljxvdc52", type: "wallet", value: heliusWallet, label: heliusWallet, properties: {}, source: "s" } as const;

test("wallet-helius: scan body + parsed tx → doc, counterparties, mints", async () => {
  stubFetchOpts((url, opts) => {
    expect(url).toContain("https://mainnet.helius-rpc.com/v1/parsed-events/scan?api-key=TESTKEY");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.address).toBe(heliusWallet);
    expect(body.match.mints).toEqual([{ mint: "So11111111111111111111111111111111111111111" }]);
    expect(body.tokenAccounts).toBe("balanceChanged");
    expect(body.limit).toBe(10);
    expect(body.budget.maxScannedTransactions).toBe(1000);
    return {
      data: [{
        signature: "5xSKzM8bvpudE521jikHqASzMr23Ms4X4ieY3K8oFPFrJWCSSgYocJmHznrR8b12voDxKDH8ykdCLXSRrx6duVLH",
        parserStatus: "OK",
        parsed: {
          slot: 433950192, blockTime: 1784487060, fee: 2005000, feePayer: heliusWallet, transactionStatus: "OK",
          nativeTransfers: [{ fromUserAccount: heliusWallet, toUserAccount: "teBPkZtsnaKDpGHTy1KUZeh1PbVtbrKXhzruYpRiUUs", amount: 1500000000000 }],
          tokenTransfers: [{ fromUserAccount: heliusWallet, toUserAccount: "7iWnBRRhBCiNXXPhqiGzvvBkKrvFSWqqmxRyu9VyYBxE", fromTokenAccount: "teBPkZtsnaKDpGHTy1KUZeh1PbVtbrKXhzruYpRiUUs", toTokenAccount: "2oL6my4QDDCfpgJZX1bZV1NgbmuNptKdgcE8wJm6efgk", rawTokenAmount: 1498500000000, decimals: 9, tokenStandard: "Fungible", mint: "So11111111111111111111111111111111111111112" }],
          summary: { type: "swap", description: "GV6UUmNxz2RpKxmNAPadYKb7uQpszwqQAu3qLJxVdC52 swapped 1500 SOL via Jupiter", parsedData: { type: "swap", protocol: "jupiter" } },
          instructions: [{ instructionIndex: 5, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", programName: "token", instructionName: "transfer" }],
        },
      }],
      paginationToken: "433950192:0",
      scan: { stoppedOn: "limit", scannedTransactions: 261, matchedTransactions: 1, creditsCharged: 11 },
    };
  });
  const t = (await findTransform("wallet-helius"))!;
  expect(t.inputTypes).toContain("wallet");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBe("helius");
  const r = await t.run({ ...heliusSeed }, { helius: "TESTKEY" });
  const doc = r.entities.find((e) => e.type === "document");
  expect(doc).toBeTruthy();
  expect(doc?.value).toBe("5xSKzM8bvpudE521jikHqASzMr23Ms4X4ieY3K8oFPFrJWCSSgYocJmHznrR8b12voDxKDH8ykdCLXSRrx6duVLH");
  expect(doc?.url).toBe("https://solscan.io/tx/5xSKzM8bvpudE521jikHqASzMr23Ms4X4ieY3K8oFPFrJWCSSgYocJmHznrR8b12voDxKDH8ykdCLXSRrx6duVLH");
  expect(doc?.properties.type).toBe("swap");
  expect(doc?.properties.program).toBe("token");
  expect(doc?.properties.timestamp).toMatch(/^20\d\d-/);
  expect(r.links.find((l) => l.to === doc!.id)?.label).toBe("in history");
  const cp = r.entities.find((e) => e.type === "wallet" && e.value === "teBPkZtsnaKDpGHTy1KUZeh1PbVtbrKXhzruYpRiUUs");
  expect(cp).toBeTruthy();
  expect(r.links.find((l) => l.to === cp!.id)?.label).toBe("transacted with");
  const mint = r.entities.find((e) => e.type === "wallet" && e.value === "So11111111111111111111111111111111111111112");
  expect(mint).toBeTruthy();
  expect(r.links.find((l) => l.to === mint!.id)?.label).toBe("touched mint");
  expect(r.note).toMatch(/1 matching Solana transactions/);
  expect(r.note).toMatch(/11 credits/);
});

test("wallet-helius: no key → key-missing note, no fetch", async () => {
  stubFetchOpts(() => { throw new Error("should not fetch without key"); });
  const t = (await findTransform("wallet-helius"))!;
  const r = await t.run({ ...heliusSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/key missing/i);
});

// ---------- phone-freespy (fixture is the live 5135550142 response,
// 2026-11-26, trimmed of the 90-day community timeline) ----------

const freespySeed = { id: "phone:1-513-555-0142", type: "phone", value: "+1 (513) 555-0142", label: "+1 (513) 555-0142", properties: {}, source: "s" } as const;

function freespyFixture() {
  return {
    input: "+15135550142", number: "5135550142", valid: false, reason: "fictional",
    reason_label: "Numbers from 555-0100 to 555-0199 are set aside for movies and TV. They never ring a real phone.",
    formatted: "(513) 555-0142", e164: "+15135550142",
    variants: ["(513) 555-0142", "513-555-0142", "+15135550142"],
    type: "geographic", type_label: "Geographic", country: "US",
    url: "https://freespy.app/search/5135550142/", removed: false,
    location: { npa: "513", city: "Cincinnati", state: "OH", state_name: "Ohio", cities: ["Cincinnati", "Hamilton"], lat: 39.162, lng: -84.4569, tz: "America/New_York", tz_label: "Eastern", local_time: { tz: "America/New_York", label: "Eastern", time: "9:41 am", abbr: "EST", offset: "-05:00", hour: 9, callable: true }, overlay_of: null, siblings: [283], url: "https://freespy.app/area-code/513/" },
    exchange: null,
    carrier: { name: "", line_type: "unknown", line_type_label: "Unknown", source: "", estimated: false, ported: null, caller_name: "", demo: false, fetched_at: null },
    community: { total: 0, negative: 0, positive: 0, neutral: 0, last_30d: 0, last_7d: 0, prev_7d: 0, first_at: null, last_at: null, categories: [], call_types: [], names: [], states: [], weighted: 0, top_category: null, trending: false, categories_list: [] },
    ftc: null,
    score: { score: 0, level: "unknown", label: "No reports yet", advice: "Nobody has reported this number.", confidence: "high", factors: [{ label: "Number fails NANP validation", impact: 0, detail: "Numbers from 555-0100 to 555-0199 are set aside for movies and TV. They never ring a real phone." }] },
  };
}

test("phone-freespy: carrier/spam/geo enrichment, no person entity from names", async () => {
  stubFetch((url) => {
    expect(url).toContain("freespy.app/wp-json/freespy/v1/lookup/");
    expect(url).toContain("15135550142");
    return freespyFixture();
  });
  const t = (await findTransform("phone-freespy"))!;
  expect(t.inputTypes).toContain("phone");
  expect(t.business).toBe(false);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...freespySeed }, {});
  const phone = r.entities.find((e) => e.type === "phone");
  expect(phone?.properties.formatted).toBe("(513) 555-0142");
  expect(phone?.properties.e164).toBe("+15135550142");
  expect(phone?.properties.line_type).toBe("Geographic");
  expect(phone?.properties.valid).toBe("no");
  expect(phone?.properties.invalid_reason).toMatch(/555-0100/);
  expect(phone?.properties.spam_score).toBe("0 (No reports yet)");
  expect(phone?.properties.spam_factors).toContain("Number fails NANP validation");
  expect(phone?.properties.reports).toBe("0 total (0 negative)");
  expect(phone?.url).toBe("https://freespy.app/search/5135550142/");
  expect(r.entities.some((e) => e.type === "person")).toBe(false); // community names never become people
  const loc = r.entities.find((e) => e.type === "location");
  expect(loc?.value).toBe("Cincinnati, OH");
  expect(loc?.lat).toBeCloseTo(39.162, 4);
  expect(loc?.lon).toBeCloseTo(-84.4569, 4);
  expect(loc?.properties.timezone).toBe("America/New_York");
  expect(r.links.find((l) => l.to === loc!.id)?.label).toBe("area code in");
  expect(r.note).toMatch(/unknown carrier/);
  expect(r.note).toMatch(/spam 0/);
});

test("phone-freespy: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("phone-freespy"))!;
  const r = await t.run({ ...freespySeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

// meridian — batch D tests. APPEND to src/transforms.test.ts (after the
// existing transform-run tests). Do NOT redefine stubFetch / realFetch /
// afterAll — they already exist in the file. Fixtures mirror the LIVE
// shapes verified 2026-11-26:
//  - PatentRef: OpenAPI 3.1 (v1.26.0) record schemas at
//    https://patentref.io/openapi.json — PatentResponse
//    {error:false, count, total_hits, patents:[PatentRecord]} with nested
//    assignees[].assignee_organization, inventors[].inventor_name_first|
//    last, cpc_current[].cpc_subclass_id. Data endpoints are keyed, so
//    these shapes are spec-verified, not live-response-verified.
//  - OpenAlex institutions/works: documented shapes (live checks hit the
//    exhausted shared anonymous budget, HTTP 429 "daily_budget").
//    Institutions: {meta, results:[{id (full URL), display_name, type,
//    country_code, works_count}]}; works:
//    {meta, results:[{id, title, publication_year, doi,
//    authorships:[{author:{display_name}}]}]}.

// ---------- PatentRef fixtures ----------

const patentrefPatents = {
  error: false, count: 2, total_hits: 2,
  patents: [
    {
      patent_id: "10905426", patent_title: "Widget sorting apparatus", patent_date: "2020-11-24",
      assignees: [{ assignee_id: "acme-1", assignee_organization: "ACME CORP", assignee_type: "2" }],
      inventors: [
        { inventor_name_first: "Jane", inventor_name_last: "Doe" },
        { inventor_name_first: "John", inventor_name_last: "Smith" },
      ],
      cpc_current: [{ cpc_subclass_id: "G06F" }, { cpc_subclass_id: "H04L" }],
    },
    {
      patent_id: "11234567", patent_title: "Gadget frame", patent_date: "2021-06-15",
      assignees: [{ assignee_id: "acme-1", assignee_organization: "ACME CORP", assignee_type: "2" }],
      inventors: [{ inventor_name_first: "Jane", inventor_name_last: "Doe" }],
      cpc_current: [{ cpc_subclass_id: "G06F" }],
    },
  ],
};

const patentrefCompanySeed = { id: "company:acme", type: "company", value: "Acme Corp", label: "Acme Corp", properties: {}, source: "s" } as const;
const patentrefPersonSeed = { id: "person:jane-doe", type: "person", value: "Jane Doe", label: "Jane Doe", properties: {}, source: "s" } as const;

test("company-patents: patents + inventors, q uses _text_phrase on assignee org", async () => {
  stubFetch((url) => {
    expect(url).toContain("patentref.io/api/v1/patent/");
    const q = JSON.parse(new URL(url).searchParams.get("q")!);
    expect(q).toEqual({ _text_phrase: { "assignees.assignee_organization": "Acme Corp" } });
    const f = JSON.parse(new URL(url).searchParams.get("f")!);
    expect(f).toContain("cpc_current");
    return patentrefPatents;
  });
  const t = (await findTransform("company-patents"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBe("patentref");
  const r = await t.run({ ...patentrefCompanySeed }, { patentref: "TESTKEY" });
  const doc = r.entities.find((e) => e.type === "document" && e.value === "US10905426");
  expect(doc).toBeTruthy();
  expect(doc?.properties.title).toBe("Widget sorting apparatus");
  expect(doc?.properties.grant_date).toBe("2020-11-24");
  expect(doc?.properties.cpc).toBe("G06F, H04L");
  expect(doc?.properties.assignee).toBe("ACME CORP");
  expect(doc?.url).toBe("https://patentref.io/p/10905426");
  expect(r.entities.some((e) => e.type === "document" && e.value === "US11234567")).toBe(true);
  const jane = r.entities.find((e) => e.type === "person" && e.value === "Jane Doe");
  expect(jane).toBeTruthy(); // deduped across both patents
  expect(r.entities.filter((e) => e.type === "person").map((e) => e.value).sort())
    .toEqual(["Jane Doe", "John Smith"]);
  expect(r.links.find((l) => l.to === doc!.id)?.label).toBe("assignee on");
  expect(r.links.find((l) => l.to === jane!.id)?.label).toBe("invented by");
  expect(r.note).toBe("2 patents for Acme Corp (2 inventors)");
});

test("company-patents: X-Api-Key header is sent", async () => {
  let sentKey = "";
  (globalThis as any).fetch = async (_url: string, opts?: any) => {
    sentKey = String(opts?.headers?.["X-Api-Key"] || "");
    return { ok: true, status: 200, json: async () => patentrefPatents } as any;
  };
  const t = (await findTransform("company-patents"))!;
  await t.run({ ...patentrefCompanySeed }, { patentref: "TESTKEY" });
  expect(sentKey).toBe("TESTKEY");
});

test("company-patents: no key → key-missing note, no fetch", async () => {
  stubFetch(() => { throw new Error("should not fetch without key"); });
  const t = (await findTransform("company-patents"))!;
  const r = await t.run({ ...patentrefCompanySeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/key missing/i);
});

test("company-patents: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("company-patents"))!;
  const r = await t.run({ ...patentrefCompanySeed }, { patentref: "TESTKEY" });
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

test("company-patents: 403 → key-rejected note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 403, json: async () => ({}) }) as any;
  const t = (await findTransform("company-patents"))!;
  const r = await t.run({ ...patentrefCompanySeed }, { patentref: "TESTKEY" });
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/key rejected/);
});

test("company-patents: no patents → empty, not failed", async () => {
  stubFetch(() => ({ error: false, count: 0, total_hits: 0, patents: [] }));
  const t = (await findTransform("company-patents"))!;
  const r = await t.run({ ...patentrefCompanySeed }, { patentref: "TESTKEY" });
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no PatentRef patents found/);
});

test("person-patents: patents + assignee companies, q splits first/last name", async () => {
  stubFetch((url) => {
    expect(url).toContain("patentref.io/api/v1/patent/");
    const q = JSON.parse(new URL(url).searchParams.get("q")!);
    expect(q).toEqual({ _and: [
      { _text_phrase: { "inventors.inventor_name_first": "Jane" } },
      { _text_phrase: { "inventors.inventor_name_last": "Doe" } },
    ] });
    return patentrefPatents;
  });
  const t = (await findTransform("person-patents"))!;
  expect(t.inputTypes).toContain("person");
  expect(t.business).toBe(false);
  expect(t.needsKey).toBe("patentref");
  const r = await t.run({ ...patentrefPersonSeed }, { patentref: "TESTKEY" });
  expect(r.entities.filter((e) => e.type === "document").length).toBe(2);
  const co = r.entities.find((e) => e.type === "company" && e.value === "ACME CORP");
  expect(co).toBeTruthy(); // deduped across both patents
  expect(r.links.find((l) => l.to === co!.id)?.label).toBe("assigned to");
  expect(r.links.some((l) => l.label === "inventor on")).toBe(true);
  expect(r.note).toBe("2 patents by Jane Doe (1 assignees)");
});

test("person-patents: single-name input queries last name only", async () => {
  stubFetch((url) => {
    const q = JSON.parse(new URL(url).searchParams.get("q")!);
    expect(q).toEqual({ _text_phrase: { "inventors.inventor_name_last": "Doe" } });
    return patentrefPatents;
  });
  const t = (await findTransform("person-patents"))!;
  const r = await t.run({ ...patentrefPersonSeed, value: "Doe" }, { patentref: "TESTKEY" });
  expect(r.entities.filter((e) => e.type === "document").length).toBe(2);
});

test("person-patents: no key → key-missing note, no fetch", async () => {
  stubFetch(() => { throw new Error("should not fetch without key"); });
  const t = (await findTransform("person-patents"))!;
  const r = await t.run({ ...patentrefPersonSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/key missing/i);
});

// ---------- OpenAlex company-papers fixtures ----------

const openalexInstitution = {
  meta: { count: 1, per_page: 3 },
  results: [{
    id: "https://openalex.org/I136199984",
    display_name: "Massachusetts Institute of Technology",
    type: "education", country_code: "US", works_count: 123456, cited_by_count: 999999,
  }],
};
const openalexInstWorks = {
  meta: { count: 2, per_page: 8 },
  results: [
    { id: "https://openalex.org/W1", title: "A study of widgets", publication_year: 2024, doi: "https://doi.org/10.1234/widget", authorships: [{ author: { display_name: "Jane Doe" } }] },
    { id: "https://openalex.org/W2", title: "Gadgets revisited", publication_year: 2023, doi: null, authorships: [] },
  ],
};

const openalexCompanySeed = { id: "company:mit", type: "company", value: "Massachusetts Institute of Technology", label: "MIT", properties: {}, source: "s" } as const;

test("company-papers: institution + works, key sent as api_key param", async () => {
  stubFetch((url) => {
    expect(url).toContain("api_key=TESTKEY"); // both calls carry the key
    if (url.includes("/institutions?")) return openalexInstitution;
    if (url.includes("/works?")) return openalexInstWorks;
    throw new Error("unexpected url " + url);
  });
  const t = (await findTransform("company-papers"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(false);
  expect(t.needsKey).toBe("openalex");
  const r = await t.run({ ...openalexCompanySeed }, { openalex: "TESTKEY" });
  const inst = r.entities.find((e) => e.type === "company" && e.value === "Massachusetts Institute of Technology");
  expect(inst).toBeTruthy();
  expect(inst?.properties.type).toBe("education");
  expect(inst?.properties.country).toBe("US");
  expect(inst?.properties.works).toBe("123,456");
  expect(inst?.url).toBe("https://openalex.org/I136199984");
  expect(r.links.find((l) => l.to === inst!.id)?.label).toBe("matched institution");
  const doc = r.entities.find((e) => e.type === "document" && e.value === "A study of widgets");
  expect(doc?.properties.year).toBe("2024");
  expect(doc?.properties.doi).toBe("https://doi.org/10.1234/widget");
  expect(r.entities.some((e) => e.type === "document" && e.value === "Gadgets revisited")).toBe(true);
  expect(r.entities.filter((e) => e.type === "person").length).toBe(0); // works + institution only
  expect(r.links.find((l) => l.to === doc!.id)?.label).toBe("published");
  expect(r.note).toBe("Massachusetts Institute of Technology: 2 recent works");
});

test("company-papers: no key → same results, no api_key param (graceful degrade)", async () => {
  stubFetch((url) => {
    expect(url).not.toContain("api_key=");
    if (url.includes("/institutions?")) return openalexInstitution;
    if (url.includes("/works?")) return openalexInstWorks;
    throw new Error("unexpected url " + url);
  });
  const t = (await findTransform("company-papers"))!;
  const r = await t.run({ ...openalexCompanySeed }, {});
  expect(r.entities.some((e) => e.type === "company" && e.value === "Massachusetts Institute of Technology")).toBe(true);
  expect(r.entities.filter((e) => e.type === "document").length).toBe(2);
  expect(r.note).toMatch(/2 recent works/);
});

test("company-papers: no institution match → empty, not failed", async () => {
  stubFetch((url) => {
    expect(url).toContain("/institutions?");
    return { meta: { count: 0, per_page: 3 }, results: [] };
  });
  const t = (await findTransform("company-papers"))!;
  const r = await t.run({ ...openalexCompanySeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no OpenAlex institution match/);
});

test("company-papers: 429 on institutions → daily-budget note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("company-papers"))!;
  const r = await t.run({ ...openalexCompanySeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/daily budget/);
});

// ---------- person-papers replacement: key passing ----------

const openalexAuthor = {
  meta: { count: 1, per_page: 5 },
  results: [{
    id: "https://openalex.org/A1234567", display_name: "Jane Doe", works_count: 42,
    last_known_institutions: [{ display_name: "Massachusetts Institute of Technology" }],
  }],
};
const openalexAuthorWorks = {
  meta: { count: 1, per_page: 8 },
  results: [{ id: "https://openalex.org/W9", title: "A study of widgets", publication_year: 2024 }],
};

const openalexPersonSeed = { id: "person:jane-doe", type: "person", value: "Jane Doe", label: "Jane Doe", properties: {}, source: "s" } as const;

test("person-papers (replacement): key sent as api_key on both calls", async () => {
  stubFetch((url) => {
    expect(url).toContain("api_key=TESTKEY");
    if (url.includes("/authors?")) return openalexAuthor;
    if (url.includes("/works?")) return openalexAuthorWorks;
    throw new Error("unexpected url " + url);
  });
  const t = (await findTransform("person-papers"))!;
  expect(t.needsKey).toBe("openalex");
  expect(t.business).toBe(false);
  const r = await t.run({ ...openalexPersonSeed }, { openalex: "TESTKEY" });
  const author = r.entities.find((e) => e.type === "person" && e.value === "Jane Doe");
  expect(author?.properties.works).toBe("42");
  expect(author?.properties.affiliation).toBe("Massachusetts Institute of Technology");
  expect(author?.url).toBe("https://openalex.org/A1234567");
  const doc = r.entities.find((e) => e.type === "document" && e.value === "A study of widgets");
  expect(doc?.properties.year).toBe("2024");
  expect(r.links.find((l) => l.to === doc!.id)?.label).toBe("authored");
  expect(r.note).toBe("2 authors & works");
});

test("person-papers (replacement): no key → identical behaviour, no api_key param", async () => {
  stubFetch((url) => {
    expect(url).not.toContain("api_key=");
    if (url.includes("/authors?")) return openalexAuthor;
    if (url.includes("/works?")) return openalexAuthorWorks;
    throw new Error("unexpected url " + url);
  });
  const t = (await findTransform("person-papers"))!;
  const r = await t.run({ ...openalexPersonSeed }, {});
  expect(r.entities.map((e) => e.value).sort()).toEqual(["A study of widgets", "Jane Doe"]);
  expect(r.note).toBe("2 authors & works");
});

test("person-papers (replacement): 429 → daily-budget note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("person-papers"))!;
  const r = await t.run({ ...openalexPersonSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/daily budget/);
});

function stubFetchRaw(handler: (url: string, opts?: any) => any) {
  (globalThis as any).fetch = async (url: string | URL, opts?: any) => {
    const res = handler(String(url), opts);
    if (res && typeof res === "object" && "status" in res && "body" in res) {
      const body = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      return {
        ok: res.status >= 200 && res.status < 300, status: res.status,
        json: async () => JSON.parse(body), text: async () => body,
      } as any;
    }
    return {
      ok: true, status: 200,
      json: async () => res,
      text: async () => (typeof res === "string" ? res : JSON.stringify(res)),
    } as any;
  };
}

// ---------- company-vendorhistory (fixtures mirror the live ADP / Paycom /
// Microsoft pages fetched 2026-11-26) ----------

const VH_ADP_HTML = `<!doctype html><html><head><title>Was ADP hacked? Data breach history | Vendor History</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Dataset","name":"ADP security incident history","description":"As of Nov 26, 2026, Vendor History found 2 state breach notices for ADP, dated Jun 5, 2013 to Jun 8, 2015. The most recent breach notice or SEC filing was on Jun 8, 2015. Sources checked: the California, Washington, Oregon and Delaware breach notice lists, SEC EDGAR (Form 8-K, Items 1.05 and 1.03) and Ransomware.live (ransomware group claims).","url":"https://vendorhistory.com/vendor/adp","license":"https://creativecommons.org/licenses/by/4.0/","isAccessibleForFree":true,"creator":{"@type":"Organization","name":"Vendor History","url":"https://vendorhistory.com"},"dateModified":"2026-11-26","temporalCoverage":"2013-06-05/2015-06-08"}]}</script></head><body>
<h2>Breach notices and SEC filings <span class="ct">2</span></h2>
<ol class="incidents">
<li class="incident">
  <div class="meta"><time datetime="2015-06-08">Jun 8, 2015</time><span class="tag tag-breach-notice">Breach notice</span></div>
  <p>ADP, LLC filed a data breach notice with the California Attorney General. Breach date(s) listed: 04/07/2015, 05/18/2015.</p>
  <p class="src">Source: <a href="https://oag.ca.gov/privacy/databreach/list?field_sb24_org_name_value=ADP%2C%20LLC" rel="nofollow noopener">California Attorney General</a></p>
</li>
<li class="incident">
  <div class="meta"><time datetime="2013-06-05">Jun 5, 2013</time><span class="tag tag-breach-notice">Breach notice</span></div>
  <p>ADP filed a data breach notice with the California Attorney General.</p>
  <p class="src">Source: <a href="https://oag.ca.gov/privacy/databreach/list?field_sb24_org_name_value=ADP" rel="nofollow noopener">California Attorney General</a></p>
</li>
</ol>
<h2>Ransomware group claims <span class="ct">1</span></h2>
<ol class="incidents">
<li class="incident">
  <div class="meta"><time datetime="2023-07-13">Jul 13, 2023</time><span class="tag tag-ransomware-claim">Ransomware claim, unconfirmed</span></div>
  <p>The ransomware group clop listed "PAYCOM.COM" as a victim on its leak site. This is a claim by a criminal group. It has not been confirmed by Paycom or a regulator.</p>
  <p class="src">Source: <a href="https://www.ransomware.live/id/UEFZQ09NLkNPTUBjbG9w" rel="nofollow noopener">Ransomware.live</a></p>
</li>
</ol>
<h2>Actively exploited security flaws <span class="ct">391</span></h2>
<details class="yr" open><summary>2026 <span class="ct">41</span></summary>
<ol class="incidents">
<li class="incident">
  <div class="meta"><time datetime="2026-11-10">Nov 10, 2026</time><span class="tag tag-exploited-flaw">Exploited flaw</span></div>
  <p>Microsoft Office Outlook Missing User Interaction for Potentially Unsafe Action Vulnerability (CVE-2026-124194). Added to CISA's list of security flaws known to be exploited by attackers.</p>
  <p class="src">Source: <a href="https://nvd.nist.gov/vuln/detail/CVE-2026-124194" rel="nofollow noopener">CISA Known Exploited Vulnerabilities catalog</a></p>
</li>
</ol></details></body></html>`;

const vendorhistorySeed = { id: "company:adp", type: "company", value: "ADP", label: "ADP", properties: {}, source: "s" } as const;

test("company-vendorhistory: notices + ransomware claim + KEV flaw, JSON-LD date", async () => {
  stubFetchRaw((url) => {
    expect(url).toBe("https://vendorhistory.com/vendor/adp");
    return { status: 200, body: VH_ADP_HTML };
  });
  const t = (await findTransform("company-vendorhistory"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...vendorhistorySeed }, {});
  expect(r.entities.length).toBe(4);
  const notice = r.entities.find((e) => e.value === "ADP breach-notice 2015-06-08");
  expect(notice).toBeTruthy();
  expect(notice?.properties.kind).toBe("Breach notice");
  expect(notice?.properties.date).toBe("2015-06-08");
  expect(notice?.properties.source).toBe("California Attorney General");
  expect(notice?.properties.summary).toMatch(/filed a data breach notice/);
  expect(notice?.properties.attribution).toMatch(/Vendor History \(CC BY 4\.0\)/);
  expect(notice?.url).toContain("oag.ca.gov");
  expect(r.links.find((l) => l.to === notice!.id)?.label).toBe("breach notice");
  const claim = r.entities.find((e) => e.value === "ADP ransomware-claim 2023-07-13");
  expect(claim?.properties.kind).toBe("Ransomware claim (unconfirmed)");
  expect(claim?.properties.confirmed).toMatch(/unconfirmed/);
  expect(claim?.properties.source).toBe("Ransomware.live");
  expect(r.links.find((l) => l.to === claim!.id)?.label).toBe("ransomware claim (unconfirmed)");
  const kev = r.entities.find((e) => e.value === "ADP kev-flaw 2026-11-10 CVE-2026-124194");
  expect(kev?.label).toBe("CVE-2026-124194");
  expect(kev?.properties.kind).toBe("Exploited flaw (CISA KEV)");
  expect(kev?.properties.cve).toBe("CVE-2026-124194");
  expect(r.links.find((l) => l.to === kev!.id)?.label).toBe("exploited flaw (CISA KEV)");
  expect(r.note).toMatch(/2 breach notice\(s\), 1 ransomware claim\(s\) \(unconfirmed\), 1 exploited flaw\(s\) \(CISA KEV\)/);
  expect(r.note).toMatch(/checked 2026-11-26/);
});

test("company-vendorhistory: unknown slug (404) → 'not tracked', not failed", async () => {
  stubFetchRaw((url) => {
    expect(url).toContain("vendorhistory.com/vendor/zzz");
    return { status: 404, body: "" };
  });
  const t = (await findTransform("company-vendorhistory"))!;
  const r = await t.run({ ...vendorhistorySeed, value: "Zzznothing Corp" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/not tracked by Vendor History/);
});

test("company-vendorhistory: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "" }) as any;
  const t = (await findTransform("company-vendorhistory"))!;
  const r = await t.run({ ...vendorhistorySeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

// ---------- company-cdr (fixtures mirror the live list + detail shapes
// verified 2026-11-26: envelope {version, as_of, license, count, data},
// rows with pathway_primary/secondary, liveliness_tier/score, size_class,
// registries; detail wraps the same row in {data}) ----------

function cdrStub(detailFail = false) {
  return stubFetchRaw((url) => {
    if (url === "https://captaindrawdown.com/api/v1/companies.json") {
      return {
        version: "2026-11.5", as_of: "2026-11-16", dataset: "companies",
        license: "CC BY-NC-SA 4.0", license_url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
        count: 1062,
        data: [
          { name: "1PointFive", slug: "1pointfive", profile_url: "https://captaindrawdown.com/directory/1pointfive/", url: "https://www.1pointfive.com/", country: "United States", country_code: "US", pathway_primary: "DAC", pathway_secondary: "Mineralization", category: "DAC", cdr_focus: "division", liveliness_tier: "Active", liveliness_score: 75, size_class: "Small (10 to 49)", registries: null, last_evidence_date: "2025-09-12", description: "1PointFive is a Houston-based CCUS subsidiary of Occidental Petroleum developing the STRATOS direct air capture facility." },
          { name: "280 Earth", slug: "280-earth", profile_url: "https://captaindrawdown.com/directory/280-earth/", url: "https://280.earth", country: "United States", country_code: "US", pathway_primary: "DAC", pathway_secondary: null, category: "DAC", cdr_focus: "supplier", liveliness_tier: "Moderate", liveliness_score: 100, size_class: "Small (10 to 49)", registries: "cdrjobsearth", last_evidence_date: "2026-03-11", description: "280 Earth was launched in 2018 at X, Google's moonshot factory, and spun out in 2022." },
          { name: "2dot0", slug: "2dot0", profile_url: "https://captaindrawdown.com/directory/2dot0/", url: "https://2dot0farms.com/", country: "India", country_code: "IN", pathway_primary: "Biochar", pathway_secondary: "Afforestation", category: "Unknown", cdr_focus: "supplier", liveliness_tier: "Moderate", liveliness_score: 55, size_class: null, registries: null, last_evidence_date: null, description: "2dot0 Farms is a small Indian regenerative-agriculture enterprise." },
        ],
      };
    }
    if (url.includes("/api/v1/companies/")) {
      if (detailFail) throw new Error("detail down");
      const slugPart = url.split("/").pop()!.replace(".json", "");
      const row = { "1pointfive": "1PointFive", "280-earth": "280 Earth", "2dot0": "2dot0" }[slugPart];
      return { version: "2026-11.5", as_of: "2026-11-16", dataset: "companies", license: "CC BY-NC-SA 4.0", data: { name: row, slug: slugPart, profile_url: `https://captaindrawdown.com/directory/${slugPart}/`, country: slugPart === "2dot0" ? "India" : "United States", pathway_primary: slugPart === "2dot0" ? "Biochar" : "DAC", pathway_secondary: slugPart === "1pointfive" ? "Mineralization" : null, liveliness_tier: slugPart === "1pointfive" ? "Active" : "Moderate", liveliness_score: slugPart === "280-earth" ? 100 : 75, size_class: "Small (10 to 49)", registries: slugPart === "280-earth" ? "cdrjobsearth" : null, description: `${row} (detail record).` } };
    }
    throw new Error(`unexpected CDR url ${url}`);
  });
}

const cdrSeed = { id: "company:acme", type: "company", value: "Acme", label: "Acme", properties: {}, source: "s" } as const;

test("company-cdr: substring match + detail fields + licence attribution", async () => {
  cdrStub();
  const t = (await findTransform("company-cdr"))!;
  expect(t.inputTypes).toContain("company");
  expect(t.business).toBe(true);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...cdrSeed, value: "280 Earth" }, {});
  expect(r.entities.length).toBe(1);
  const co = r.entities[0];
  expect(co.type).toBe("company");
  expect(co.value).toBe("280 Earth");
  expect(co.properties.pathway).toBe("DAC");
  expect(co.properties.country).toBe("United States");
  expect(co.properties.liveliness).toBe("Moderate (100)");
  expect(co.properties.size).toBe("Small (10 to 49)");
  expect(co.properties.registry).toBe("cdrjobsearth");
  expect(co.properties.via).toMatch(/CC BY-NC-SA 4\.0/);
  expect(co.url).toBe("https://captaindrawdown.com/directory/280-earth/");
  expect(r.links[0].label).toBe("listed in CDR directory");
  expect(r.note).toBe("1 CDR company (CC BY-NC-SA 4.0 — non-commercial reuse only)");
});

test("company-cdr: detail down → list row still returned", async () => {
  cdrStub(true);
  const t = (await findTransform("company-cdr"))!;
  const r = await t.run({ ...cdrSeed, value: "1Point" }, {});
  expect(r.entities.some((e) => e.type === "company" && e.value === "1PointFive")).toBe(true);
  const co = r.entities.find((e) => e.value === "1PointFive")!;
  expect(co.properties.pathway).toBe("DAC + Mineralization");
  expect(co.properties.liveliness).toBe("Active (75)");
  expect(r.note).toBe("1 CDR company (CC BY-NC-SA 4.0 — non-commercial reuse only)");
});

test("company-cdr: no matches → empty, not failed", async () => {
  cdrStub();
  const t = (await findTransform("company-cdr"))!;
  const r = await t.run({ ...cdrSeed, value: "Zzznothing Corp" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no CDR directory matches/);
});

test("company-cdr: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("company-cdr"))!;
  const r = await t.run({ ...cdrSeed, value: "Acme" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});

// ---------- email-orelys (POST response shape per docs.orelys.io; breach
// names/dates are real rows from the live GET /v1/breaches list, 2026-11-26.
// The POST itself is docs-verified, NOT live-verified.) ----------

function orelysStub(found: boolean) {
  return stubFetchRaw((url, opts) => {
    expect(url).toBe("https://api.orelys.io/v1/breaches/check");
    expect(opts?.method).toBe("POST");
    expect(opts?.headers?.["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.email).toBe("jane@example.com");
    if (!found) return { breaches: [], hidden: 0 };
    return {
      breaches: [
        { name: "Momentum Telecom", breach_date: "2026-11-14", found_types: ["phone", "full_name", "location_street", "email"] },
        { name: "Expedia Group, Inc.", breach_date: "2026-11-09", found_types: ["email", "birth", "phone", "full_name"] },
      ],
      hidden: 1,
    };
  });
}

const orelysSeed = { id: "email:jane-example-com", type: "email", value: "jane@example.com", label: "jane@example.com", properties: {}, source: "s" } as const;

test("email-orelys: breaches + data-type categories only, hidden count noted", async () => {
  orelysStub(true);
  const t = (await findTransform("email-orelys"))!;
  expect(t.inputTypes).toContain("email");
  expect(t.business).toBe(false);
  expect(t.needsKey).toBeUndefined();
  const r = await t.run({ ...orelysSeed }, {});
  expect(r.entities.length).toBe(2);
  const mom = r.entities.find((e) => e.value === "Momentum Telecom (2026-11-14)");
  expect(mom).toBeTruthy();
  expect(mom?.type).toBe("document");
  expect(mom?.properties.breach_date).toBe("2026-11-14");
  expect(mom?.properties.data_types).toBe("phone, full_name, location_street, email");
  expect(mom?.properties.exposure).toMatch(/never record values/);
  expect(r.links.find((l) => l.to === mom!.id)?.label).toBe("exposed in");
  // Never record values: no entity property may carry the queried address.
  expect(JSON.stringify(r.entities)).not.toContain("jane@example.com");
  expect(r.note).toBe("2 breaches expose this address (+ 1 sensitive breach not named publicly)");
});

test("email-orelys: no breaches → empty, not failed", async () => {
  orelysStub(false);
  const t = (await findTransform("email-orelys"))!;
  const r = await t.run({ ...orelysSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/no known breaches hold this address/);
});

test("email-orelys: invalid email → graceful empty, no fetch", async () => {
  stubFetchRaw(() => { throw new Error("should not fetch for an invalid email"); });
  const t = (await findTransform("email-orelys"))!;
  const r = await t.run({ ...orelysSeed, value: "not-an-email" }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/not an email address/);
});

test("email-orelys: 429 → rate-limit note, no throw", async () => {
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }) as any;
  const t = (await findTransform("email-orelys"))!;
  const r = await t.run({ ...orelysSeed }, {});
  expect(r.entities).toEqual([]);
  expect(r.note).toMatch(/rate limit/);
});
