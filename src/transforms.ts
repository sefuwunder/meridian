// meridian — Maltego-style entity + transform layer.
//
// The pivot: instead of city-scoped recon runs, investigations are graphs of
// typed *entities* (domain, ip, person, company, …). *Transforms* take one
// entity and produce new entities + labeled links — the 36 recon collectors
// in sources.ts survive as the transform implementations, re-scoped from
// "everything about a city" to "everything about this entity".
//
// Zero deps. All transforms are best-effort: one failed source never sinks
// the transform, and every transform reports what it found.

export type EntityType =
  | "domain" | "ip" | "person" | "company" | "email" | "phone"
  | "location" | "url" | "netblock" | "as" | "document" | "note";

export interface EntityTypeMeta { label: string; icon: string; color: string; }

export const ENTITY_TYPES: Record<EntityType, EntityTypeMeta> = {
  domain:   { label: "Domain",        icon: "🌐", color: "#4A90D9" },
  ip:       { label: "IP address",    icon: "🖧", color: "#7B61FF" },
  person:   { label: "Person",        icon: "👤", color: "#E8A838" },
  company:  { label: "Company",       icon: "🏢", color: "#50B498" },
  email:    { label: "Email",         icon: "✉️", color: "#D95F4B" },
  phone:    { label: "Phone",         icon: "📞", color: "#9B59B6" },
  location: { label: "Location",      icon: "📍", color: "#E74C3C" },
  url:      { label: "URL",           icon: "🔗", color: "#3498DB" },
  netblock: { label: "Netblock",      icon: "🕸️", color: "#5D6D7E" },
  as:       { label: "Autonomous sys",icon: "🛣️", color: "#16A085" },
  document: { label: "Document",      icon: "📄", color: "#95A5A6" },
  note:     { label: "Analyst note",  icon: "📝", color: "#F4D03F" },
};

export interface Entity {
  id: string;                        // "domain:example.com" — deterministic
  type: EntityType;
  value: string;                     // canonical value
  label: string;                     // display label
  properties: Record<string, string>; // key facts shown in the detail panel
  source: string;                    // creating transform/source
  url?: string;                      // pivot-out link
  lat?: number; lon?: number;
  note?: string;
}

export interface Elink { from: string; to: string; label: string; }

export interface TransformResult {
  entities: Entity[];
  links: Elink[];
  note: string;                      // human summary: "12 subdomains found"
}

export interface TransformDef {
  key: string;
  label: string;
  description: string;
  inputTypes: EntityType[];
  needsKey?: string;                 // key id from keys.ts, when required
  run: (e: Entity, keys: Record<string, string>) => Promise<TransformResult>;
}

// ---------- helpers ----------

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

export const entityId = (type: EntityType, value: string) => `${type}:${slug(value)}`;

async function fetchJson(url: string, opts: RequestInit = {}, timeoutMs = 20000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, headers: { "User-Agent": "meridian-osint/2.0", ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function mkEntity(type: EntityType, value: string, source: string, extra: Partial<Entity> = {}): Entity {
  const label = extra.label || value.slice(0, 60);
  return {
    id: entityId(type, value), type, value,
    label, properties: {}, source, ...extra,
  };
}

/** Best-effort wrapper: a transform never throws, it reports. */
async function safeRun(
  def: Omit<TransformDef, "run">,
  fn: (e: Entity, keys: Record<string, string>) => Promise<Omit<TransformResult, "note"> & { note?: string }>,
): Promise<TransformDef> {
  return {
    ...def,
    run: async (e, keys) => {
      try {
        const r = await fn(e, keys);
        return { entities: r.entities, links: r.links, note: r.note || `${r.entities.length} entities found` };
      } catch (err: any) {
        return { entities: [], links: [], note: `failed: ${String(err?.message || err).slice(0, 120)}` };
      }
    },
  };
}

/** Guess an entity type from a raw value (search box / seed input). */
export function detectEntityType(raw: string): EntityType {
  const v = raw.trim();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return "ip";
  if (/^[0-9a-fA-F:]{3,}$/.test(v) && v.includes(":")) return "ip"; // v6
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "email";
  if (/^\+?[\d][\d\s\-().]{6,}$/.test(v) && /\d{7,}/.test(v.replace(/\D/g, ""))) return "phone";
  if (/^https?:\/\//i.test(v)) return "url";
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)) return "domain";
  if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(v)) return "netblock";
  return "company"; // default: treat as an organization/person name search
}

// =====================================================================
// TRANSFORMS
// =====================================================================

async function buildTransforms(): Promise<TransformDef[]> {
  const defs: TransformDef[] = [];

  // ---------- domain → subdomains (Cert Spotter) ----------
  defs.push(await safeRun(
    {
      key: "cert-subdomains", label: "Subdomains · Cert Spotter",
      description: "Certificate-transparency issuances for this domain and its subdomains",
      inputTypes: ["domain"],
    },
    async (e) => {
      const domain = e.value.toLowerCase();
      const j = await fetchJson(
        `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}` +
        `&include_subdomains=true&expand=dns_names`);
      const rows = Array.isArray(j) ? j : [];
      const names = new Map<string, string>();
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        const iss = r.issuer && typeof r.issuer === "object"
          ? String(r.issuer.o || r.issuer.organization || "").trim() : "";
        for (const raw of (Array.isArray(r.dns_names) ? r.dns_names : [])) {
          const name = String(raw || "").trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
          if (!name || name === domain || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(name)) continue;
          if (!names.has(name)) names.set(name, iss);
        }
        if (names.size >= 40) break;
      }
      const entities: Entity[] = [], links: Elink[] = [];
      for (const [name, iss] of names) {
        entities.push(mkEntity("domain", name, "certspotter", {
          properties: {
            ...(iss ? { issuer: iss.slice(0, 60) } : {}),
            via: "certificate transparency",
          },
        }));
        links.push({ from: e.id, to: entityId("domain", name), label: name.endsWith(`.${domain}`) ? "subdomain of" : "cert-linked" });
      }
      return { entities, links, note: `${entities.length} DNS names in CT logs` };
    }
  ));

  // ---------- domain → passive DNS (mnemonic) ----------
  defs.push(await safeRun(
    {
      key: "dns-history", label: "Passive DNS · mnemonic",
      description: "Historical A/AAAA/CNAME answers observed for this domain",
      inputTypes: ["domain"],
    },
    async (e) => {
      const domain = e.value.toLowerCase();
      const j = await fetchJson(`https://api.mnemonic.no/pdns/v3/${encodeURIComponent(domain)}`);
      const records = Array.isArray(j?.data) ? j.data : [];
      const scored = records
        .filter((r: any) => r && typeof r === "object" && ["A", "AAAA", "CNAME"].includes(String(r.rrtype || "").toUpperCase()))
        .map((r: any) => ({
          answer: String(r.answer || "").trim().replace(/\.$/, ""),
          rrtype: String(r.rrtype || "").toUpperCase(),
          times: Number(r.times) || 0,
          lastSeen: Number(r.lastSeenTimestamp) || 0,
        }))
        .filter((r: any) => r.answer)
        .sort((a: any, b: any) => b.times - a.times)
        .slice(0, 15);
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      for (const r of scored) {
        const last = r.lastSeen ? new Date(r.lastSeen).toISOString().slice(0, 10) : "unknown";
        if (r.rrtype === "CNAME") {
          const id = entityId("domain", r.answer);
          if (!seen.has(id)) {
            seen.add(id);
            entities.push(mkEntity("domain", r.answer, "mnemonic", {
              properties: { observations: r.times.toLocaleString("en-US"), lastSeen: last },
            }));
          }
          links.push({ from: e.id, to: id, label: "points to" });
        } else {
          const id = entityId("ip", r.answer);
          if (!seen.has(id)) {
            seen.add(id);
            entities.push(mkEntity("ip", r.answer, "mnemonic", {
              properties: { observations: r.times.toLocaleString("en-US"), lastSeen: last },
            }));
          }
          links.push({ from: e.id, to: id, label: "resolves" });
        }
      }
      return { entities, links, note: `${scored.length} passive-DNS answers` };
    }
  ));

  // ---------- domain → urlscan ----------
  defs.push(await safeRun(
    {
      key: "domain-scans", label: "Web scans · urlscan.io",
      description: "Recent urlscan.io scans touching this domain",
      inputTypes: ["domain"],
    },
    async (e) => {
      const domain = e.value.toLowerCase();
      const j = await fetchJson(
        `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(`domain:${domain}`)}&size=20`);
      const results = Array.isArray(j?.results) ? j.results : [];
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      for (const r of results.slice(0, 10)) {
        if (!r || typeof r !== "object") continue;
        const page = r.page && typeof r.page === "object" ? r.page : {};
        const scanId = String(r._id || "").trim();
        const pageUrl = String(page.url || "").trim();
        if (!pageUrl || seen.has(pageUrl)) continue;
        seen.add(pageUrl);
        entities.push(mkEntity("url", pageUrl, "urlscan", {
          properties: {
            ...(page.ip ? { ip: String(page.ip) } : {}),
            ...(page.country ? { country: String(page.country).toUpperCase() } : {}),
            ...(page.server ? { server: String(page.server).slice(0, 40) } : {}),
          },
          url: scanId ? `https://urlscan.io/result/${scanId}/` : undefined,
        }));
        links.push({ from: e.id, to: entityId("url", pageUrl), label: "scanned" });
        const ip = String(page.ip || "").trim();
        if (ip && !seen.has(`ip:${ip}`)) {
          seen.add(`ip:${ip}`);
          entities.push(mkEntity("ip", ip, "urlscan"));
          links.push({ from: entityId("url", pageUrl), to: entityId("ip", ip), label: "hosted on" });
        }
      }
      return { entities, links, note: `${entities.length} scan results` };
    }
  ));

  // ---------- ip → ports/vulns (Shodan InternetDB) ----------
  defs.push(await safeRun(
    {
      key: "ip-ports", label: "Ports & vulns · Shodan InternetDB",
      description: "Open ports, hostnames, known CVEs and tags for this IP",
      inputTypes: ["ip"],
    },
    async (e) => {
      const j = await fetchJson(`https://internetdb.shodan.io/${encodeURIComponent(e.value)}`, {}, 15000);
      if (!j || typeof j !== "object" || !j.ip) return { entities: [], links: [], note: "no data for this IP" };
      const ports = (Array.isArray(j.ports) ? j.ports : []).map(Number).filter(Number.isFinite);
      const vulns = (Array.isArray(j.vulns) ? j.vulns : []).map(String).filter(Boolean);
      const hostnames = (Array.isArray(j.hostnames) ? j.hostnames : []).map(String).filter(Boolean);
      const tags = (Array.isArray(j.tags) ? j.tags : []).map(String).filter(Boolean);
      const props: Record<string, string> = {};
      if (ports.length) props.ports = ports.slice(0, 12).join(", ") + (ports.length > 12 ? "…" : "");
      if (vulns.length) props.vulns = `${vulns.length}: ${vulns.slice(0, 3).join(", ")}`;
      if (tags.length) props.tags = tags.slice(0, 4).join(", ");
      const entities: Entity[] = [mkEntity("ip", e.value, "internetdb", { properties: props })];
      const links: Elink[] = [];
      for (const h of hostnames.slice(0, 5)) {
        entities.push(mkEntity("domain", h.toLowerCase(), "internetdb"));
        links.push({ from: e.id, to: entityId("domain", h.toLowerCase()), label: "hostname" });
      }
      return { entities, links, note: `${ports.length} open ports, ${vulns.length} vulns` };
    }
  ));

  // ---------- ip → intel (IPQuery) ----------
  defs.push(await safeRun(
    {
      key: "ip-intel", label: "IP intel · IPQuery",
      description: "ASN, geolocation and risk signals for this IP",
      inputTypes: ["ip"],
    },
    async (e) => {
      const j = await fetchJson(`https://api.ipquery.io/${encodeURIComponent(e.value)}?format=json`, {}, 15000);
      if (!j || typeof j !== "object" || j.status === "error") return { entities: [], links: [], note: "no data for this IP" };
      const props: Record<string, string> = {};
      if (j.isp) props.isp = String(j.isp).slice(0, 60);
      if (j.org) props.org = String(j.org).slice(0, 60);
      if (j.asn) props.asn = String(j.asn);
      if (j.city || j.country_code) props.geo = [j.city, j.country_code].filter(Boolean).join(", ");
      if (j.risk) props.risk = String(j.risk);
      const entities: Entity[] = [mkEntity("ip", e.value, "ipquery", {
        properties: props,
        lat: Number.isFinite(Number(j.lat)) ? Number(j.lat) : undefined,
        lon: Number.isFinite(Number(j.lon)) ? Number(j.lon) : undefined,
      })];
      const links: Elink[] = [];
      if (j.asn) {
        const asn = String(j.asn).toUpperCase().startsWith("AS") ? String(j.asn).toUpperCase() : `AS${j.asn}`;
        entities.push(mkEntity("as", asn, "ipquery", { label: asn }));
        links.push({ from: e.id, to: entityId("as", asn), label: "announced by" });
      }
      return { entities, links, note: props.isp ? `via ${props.isp}` : "intel attached" };
    }
  ));


  // ---------- company → LEI records (GLEIF name search) ----------
  defs.push(await safeRun(
    {
      key: "company-gleif", label: "Legal entities · GLEIF",
      description: "Search the global LEI registry by company name, with parent links",
      inputTypes: ["company"],
    },
    async (e) => {
      const j = await fetchJson(
        `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(e.value)}&page[size]=10`,
        {}, 25000);
      const records = Array.isArray(j?.data) ? j.data : [];
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      for (const rec of records.slice(0, 10)) {
        const lei = String(rec?.id || "").toUpperCase();
        if (!/^[0-9A-Z]{20}$/.test(lei) || seen.has(lei)) continue;
        seen.add(lei);
        const ent = rec?.attributes?.entity || {};
        const name = String(ent?.legalName?.name || lei).slice(0, 90);
        const addr = ent?.legalAddress || {};
        const props: Record<string, string> = { lei };
        const a = [addr.city, addr.country].filter(Boolean).join(", ");
        if (a) props.address = a;
        if (ent?.status) props.status = String(ent.status);
        entities.push(mkEntity("company", name, "gleif", {
          properties: props, url: `https://search.gleif.org/#/record/${lei}`,
        }));
        links.push({ from: e.id, to: entityId("company", name), label: "registered as" });
        for (const rel of ["direct-parent", "ultimate-parent"] as const) {
          const rels = rec?.relationships || {};
          const rnode = rels[rel === "direct-parent" ? "direct-parent" : "ultimate-parent"];
          const plei = String(rnode?.relationships?.["parent"]?.data?.id || "").toUpperCase();
          if (!/^[0-9A-Z]{20}$/.test(plei) || plei === lei || seen.has(plei)) continue;
          seen.add(plei);
          entities.push(mkEntity("company", plei, "gleif", {
            label: plei, properties: { lei: plei }, url: `https://search.gleif.org/#/record/${plei}`,
          }));
          links.push({ from: entityId("company", name), to: entityId("company", plei), label: rel.replace("-", " ") });
        }
      }
      return { entities, links, note: `${entities.length} LEI records` };
    }
  ));

  // ---------- company → FindAll (Parallel) ----------
  defs.push(await safeRun(
    {
      key: "company-findall", label: "Company profile · Parallel FindAll",
      description: "AI-extracted company profile: description, website, size",
      inputTypes: ["company"],
      needsKey: "parallel",
    },
    async (e, keys) => {
      const key = keys.parallel;
      if (!key) return { entities: [], links: [], note: "Parallel API key missing — add it in Settings" };
      const j = await fetchJson("https://api.parallel.ai/v1beta/findall", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({ objective: `profile of the company "${e.value}": description, website, headquarters, size`, queries: [`${e.value} company profile`], entity_type: "companies" }),
      }, 60000);
      const results = Array.isArray(j?.results) ? j.results : [];
      const entities: Entity[] = [], links: Elink[] = [];
      for (const r of results.slice(0, 5)) {
        if (!r || typeof r !== "object") continue;
        const name = String(r.name || r.title || "").slice(0, 90);
        if (!name) continue;
        const props: Record<string, string> = {};
        if (r.description) props.description = String(r.description).slice(0, 200);
        if (r.website) props.website = String(r.website);
        entities.push(mkEntity("company", name, "parallel", {
          properties: props,
          url: r.website ? String(r.website) : undefined,
        }));
        links.push({ from: e.id, to: entityId("company", name), label: "profile match" });
      }
      return { entities, links, note: `${entities.length} company profiles` };
    }
  ));

  // ---------- company → SEC EDGAR filers ----------
  defs.push(await safeRun(
    {
      key: "company-sec", label: "SEC filings · EDGAR",
      description: "SEC EDGAR filer match for this company name",
      inputTypes: ["company"],
    },
    async (e) => {
      const j = await fetchJson(
        `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(e.value)}&dateRange=custom&startdt=2020-01-01&enddt=2026-12-31&forms=10-K,10-Q,8-K`,
        { headers: { Accept: "application/json" } }, 25000);
      const hits = Array.isArray(j?.hits?.hits) ? j.hits.hits : [];
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      for (const h of hits.slice(0, 8)) {
        const src = h?._source || {};
        const cik = String(src.cik || "").replace(/^0+/, "");
        const name = String(src.entity || src.company || "").slice(0, 90);
        if (!cik || !name || seen.has(cik)) continue;
        seen.add(cik);
        entities.push(mkEntity("document", `${name} (CIK ${cik})`, "secedgar", {
          label: name.slice(0, 50),
          properties: { cik, ...(src.form ? { form: String(src.form) } : {}) },
          url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
        }));
        links.push({ from: e.id, to: entityId("document", `${name} (CIK ${cik})`), label: "files as" });
      }
      return { entities, links, note: `${entities.length} EDGAR filers` };
    }
  ));

  // ---------- company → manufacturers (SUDOKN / NSF Open Knowledge Network) ----------
  defs.push(await safeRun(
    {
      key: "company-sudokn", label: "Manufacturers · SUDOKN",
      description: "US small/medium manufacturers: street addresses, geo, NAICS, certifications, capabilities",
      inputTypes: ["company"],
    },
    async (e) => {
      const NS = "http://asu.edu/semantics/SUDOKN/";
      const sparql = async (q: string) => fetchJson(
        `https://apps.okn.us/sudokn/sparql?query=${encodeURIComponent(q)}`,
        { headers: { Accept: "application/sparql-results+json" } }, 30000);
      const rows = (j: any): any[] => Array.isArray(j?.results?.bindings) ? j.results.bindings : [];
      const lit = (b: any, k: string): string => {
        const v = b?.[k]?.value;
        return v == null ? "" : String(v);
      };
      // escape for a SPARQL "..." literal used inside REGEX(..., "i")
      const needle = e.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        .replace(/[.*+?^${}()|[\]]/g, "\\$&").slice(0, 60);
      if (!needle.trim()) return { entities: [], links: [], note: "empty company name" };
      const found = rows(await sparql(
        `SELECT ?s ?name WHERE { ` +
        `?s a <https://spec.industrialontologies.org/ontology/core/Core/Manufacturer> . ` +
        `?s <http://www.w3.org/2000/01/rdf-schema#label> ?name . ` +
        `FILTER(REGEX(?name, "${needle}", "i")) } LIMIT 5`));
      const entities: Entity[] = [], links: Elink[] = [];
      const seenCo = new Set<string>();
      const P = (p: string) => `<${NS}${p}>`;
      for (const f of found) {
        const uri = lit(f, "s"), name = lit(f, "name").slice(0, 90);
        if (!uri || !name || seenCo.has(uri)) continue;
        seenCo.add(uri);
        const U = `<${uri}>`;
        const d = rows(await sparql(
          `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ` +
          `PREFIX s: <https://schema.org/> ` +
          `PREFIX geo: <http://www.opengis.net/ont/geosparql#> ` +
          `SELECT ?desc ?emp ?web ?email ?street ?postal ?phone ?city ?state ?country ?wkt ?naics WHERE { ` +
          `${U} rdfs:label ?name . ` +
          `OPTIONAL { ${U} ${P("hasBusinessDescription")}/${P("hasTextValue")} ?desc } ` +
          `OPTIONAL { ${U} ${P("hasNumberOfEmployees")} ?emp } ` +
          `OPTIONAL { ${U} ${P("hasWebAddress")}/${P("hasVirtualLocationIdentifierValue")} ?web } ` +
          `OPTIONAL { ${U} ${P("hasEmailAddress")}/${P("hasVirtualLocationIdentifierValue")} ?email } ` +
          `OPTIONAL { ${U} ${P("hasPrimaryNAICSClassifier")}/rdfs:label ?naics } ` +
          `OPTIONAL { ${U} ${P("organizationLocatedIn")} ?g . ` +
          `OPTIONAL { ?g s:streetAddress ?street } ` +
          `OPTIONAL { ?g s:postalCode ?postal } ` +
          `OPTIONAL { ?g s:telephone ?phone } ` +
          `OPTIONAL { ?g ${P("locatedInCity")}/rdfs:label ?city } ` +
          `OPTIONAL { ?g ${P("locatedInState")}/rdfs:label ?state } ` +
          `OPTIONAL { ?g ${P("locatedInCountry")}/rdfs:label ?country } ` +
          `OPTIONAL { ?g <http://www.opengis.net/ont/geosparql#hasGeometry>/<http://www.opengis.net/ont/geosparql#asWKT> ?wkt } } } LIMIT 1`))[0] || {};
        const multi = rows(await sparql(
          `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ` +
          `SELECT ?kind ?label WHERE { { ${U} ${P("hasCertificate")} ?x . ?x a ?t . ?t rdfs:label ?label . BIND("cert" AS ?kind) } ` +
          `UNION { ${U} ${P("suppliesToIndustry")}/rdfs:label ?label . BIND("industry" AS ?kind) } ` +
          `UNION { ${U} ${P("hasProcessCapability")}/rdfs:label ?label . BIND("process" AS ?kind) } ` +
          `UNION { ${U} ${P("hasMaterialCapability")}/rdfs:label ?label . BIND("material" AS ?kind) } ` +
          `UNION { ${U} ${P("manufactures")}/rdfs:label ?label . BIND("product" AS ?kind) } } LIMIT 40`));
        const byKind = (k: string) => [...new Set(multi.filter((m) => lit(m, "kind") === k).map((m) => lit(m, "label")).filter(Boolean))];
        const props: Record<string, string> = {};
        const desc = lit(d, "desc"); if (desc) props.description = desc.slice(0, 200);
        const emp = lit(d, "emp"); if (emp) props.employees = emp;
        const naics = lit(d, "naics"); if (naics) props.naics = naics;
        const web = lit(d, "web"); if (web) props.website = web;
        const phone = lit(d, "phone"); if (phone) props.phone = phone;
        const email = lit(d, "email"); if (email) props.email = email;
        const join = (k: string) => byKind(k).slice(0, 8).join(", ").slice(0, 160);
        for (const [k, pk] of [["industry", "industries"], ["process", "processes"], ["material", "materials"], ["product", "products"]] as const) {
          const j = join(k); if (j) props[pk] = j;
        }
        const coId = entityId("company", name);
        entities.push(mkEntity("company", name, "sudokn", {
          properties: props,
          url: web ? `https://${web.replace(/^https?:\/\//, "")}` : undefined,
        }));
        links.push({ from: e.id, to: coId, label: "matched in SUDOKN" });
        // location entity from the street address + WKT point
        const addr = [lit(d, "street"), [lit(d, "city"), lit(d, "state")].filter(Boolean).join(", "), lit(d, "postal")].filter(Boolean).join(", ");
        if (addr) {
          const extra: Partial<Entity> = {
            label: addr.slice(0, 80),
            properties: {
              ...(lit(d, "city") ? { city: lit(d, "city") } : {}),
              ...(lit(d, "state") ? { state: lit(d, "state") } : {}),
              ...(lit(d, "country") ? { country: lit(d, "country") } : {}),
              ...(lit(d, "postal") ? { postal: lit(d, "postal") } : {}),
            },
          };
          const m = /POINT\(([-\d.]+)\s+([-\d.]+)\)/.exec(lit(d, "wkt"));
          if (m) { extra.lon = Number(m[1]); extra.lat = Number(m[2]); }
          entities.push(mkEntity("location", addr, "sudokn", extra));
          links.push({ from: coId, to: entityId("location", addr), label: "located at" });
        }
        // certificate documents
        for (const c of byKind("cert").slice(0, 5)) {
          entities.push(mkEntity("document", `${name} — ${c}`, "sudokn", { label: c.slice(0, 60) }));
          links.push({ from: coId, to: entityId("document", `${name} — ${c}`), label: "certified" });
        }
      }
      return { entities, links, note: `${seenCo.size} SUDOKN manufacturers` };
    }
  ));

  // ---------- person → papers (OpenAlex) ----------
  defs.push(await safeRun(
    {
      key: "person-papers", label: "Research · OpenAlex",
      description: "Papers and affiliations for this researcher",
      inputTypes: ["person"],
    },
    async (e) => {
      const j = await fetchJson(
        `https://api.openalex.org/authors?search=${encodeURIComponent(e.value)}&per-page=5`, {}, 25000);
      const authors = Array.isArray(j?.results) ? j.results : [];
      const entities: Entity[] = [], links: Elink[] = [];
      for (const a of authors.slice(0, 3)) {
        const aid = String(a?.id || "").split("/").pop();
        const name = String(a?.display_name || "").slice(0, 60);
        if (!aid || !name) continue;
        const props: Record<string, string> = {};
        if (a?.works_count) props.works = Number(a.works_count).toLocaleString("en-US");
        const aff = a?.last_known_institutions?.[0]?.display_name;
        if (aff) props.affiliation = String(aff).slice(0, 80);
        entities.push(mkEntity("person", name, "openalex", {
          properties: props, url: `https://openalex.org/${aid}`,
        }));
        links.push({ from: e.id, to: entityId("person", name), label: "author match" });
        const works = await fetchJson(
          `https://api.openalex.org/works?filter=authorships.author.id:${aid}&per-page=8&select=title,publication_year`, {}, 25000)
          .catch(() => null);
        for (const w of (Array.isArray(works?.results) ? works.results : []).slice(0, 8)) {
          const title = String(w?.title || "").slice(0, 80);
          if (!title) continue;
          const wid = entityId("document", title);
          entities.push(mkEntity("document", title, "openalex", {
            label: title.slice(0, 50),
            properties: { ...(w?.publication_year ? { year: String(w.publication_year) } : {}) },
          }));
          links.push({ from: entityId("person", name), to: wid, label: "authored" });
        }
      }
      return { entities, links, note: `${entities.length} authors & works` };
    }
  ));

  // ---------- person → donations (OpenFEC) ----------
  defs.push(await safeRun(
    {
      key: "person-donations", label: "Donations · OpenFEC",
      description: "US campaign-finance donations by donor name",
      inputTypes: ["person"],
    },
    async (e) => {
      const j = await fetchJson(
        `https://api.open.fec.gov/v1/schedules/a/?q_contributor=${encodeURIComponent(e.value)}&per_page=20&api_key=DEMO_KEY`,
        {}, 25000);
      const results = Array.isArray(j?.results) ? j.results : [];
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      for (const r of results.slice(0, 10)) {
        const cmte = String(r?.committee?.name || r?.committee_name || "").slice(0, 70);
        if (!cmte || seen.has(cmte)) continue;
        seen.add(cmte);
        const amt = r?.contribution_receipt_amount;
        entities.push(mkEntity("company", cmte, "openfec", {
          label: cmte.slice(0, 50),
          properties: { ...(amt ? { amount: `$${Number(amt).toLocaleString("en-US")}` } : {}), via: "campaign donation" },
        }));
        links.push({ from: e.id, to: entityId("company", cmte), label: "donated to" });
      }
      return { entities, links, note: `${entities.length} recipient committees` };
    }
  ));


  // ---------- location → nearby places (OpenStreetMap Overpass) ----------
  defs.push(await safeRun(
    {
      key: "location-places", label: "Nearby places · OpenStreetMap",
      description: "Businesses and amenities around these coordinates",
      inputTypes: ["location"],
    },
    async (e) => {
      if (e.lat == null || e.lon == null)
        return { entities: [], links: [], note: "location has no coordinates — re-add it with a place name" };
      const q = `[out:json][timeout:20];(node["amenity"](around:1500,${e.lat},${e.lon});node["shop"](around:1500,${e.lat},${e.lon}););out 30;`;
      const j = await fetchJson("https://overpass-api.de/api/interpreter", {
        method: "POST", headers: { "Content-Type": "text/plain" }, body: q,
      }, 30000).catch(() => null);
      const els = Array.isArray(j?.elements) ? j.elements : [];
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      for (const el of els.slice(0, 25)) {
        const name = String(el?.tags?.name || "").slice(0, 60);
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        const kind = el?.tags?.amenity || el?.tags?.shop || "place";
        entities.push(mkEntity("company", name, "overpass", {
          label: name.slice(0, 50),
          properties: { kind: String(kind).slice(0, 40) },
          lat: Number.isFinite(Number(el?.lat)) ? Number(el.lat) : undefined,
          lon: Number.isFinite(Number(el?.lon)) ? Number(el.lon) : undefined,
        }));
        links.push({ from: e.id, to: entityId("company", name), label: "nearby" });
      }
      return { entities, links, note: `${entities.length} places nearby` };
    }
  ));

  // ---------- location → aircraft (adsb.lol) ----------
  defs.push(await safeRun(
    {
      key: "location-aircraft", label: "Aircraft overhead · adsb.lol",
      description: "Live ADS-B aircraft within 25 nautical miles",
      inputTypes: ["location"],
    },
    async (e) => {
      if (e.lat == null || e.lon == null)
        return { entities: [], links: [], note: "location has no coordinates" };
      const j = await fetchJson(
        `https://api.adsb.lol/v2/lat/${e.lat.toFixed(3)}/lon/${e.lon.toFixed(3)}/dist/25`, {}, 25000)
        .catch(() => null);
      const ac = Array.isArray(j?.ac) ? j.ac : [];
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      for (const a of ac.slice(0, 15)) {
        if (!a || typeof a !== "object") continue;
        const hex = String(a.hex || "").trim().toLowerCase();
        if (!hex || seen.has(hex)) continue;
        seen.add(hex);
        const flight = String(a.flight || "").trim();
        const reg = String(a.r || "").trim();
        const label = flight || reg || hex.toUpperCase();
        entities.push(mkEntity("document", `✈ ${label}`, "adsb.lol", {
          label: label.slice(0, 40),
          properties: {
            ...(reg && reg !== flight ? { registration: reg } : {}),
            ...(a.t ? { type: String(a.t) } : {}),
          },
          lat: Number.isFinite(Number(a.lat)) ? Number(a.lat) : undefined,
          lon: Number.isFinite(Number(a.lon)) ? Number(a.lon) : undefined,
        }));
        links.push({ from: e.id, to: entityId("document", `✈ ${label}`), label: "overhead" });
      }
      return { entities, links, note: `${entities.length} aircraft overhead` };
    }
  ));

  // ---------- any → web search (Exa) ----------
  defs.push(await safeRun(
    {
      key: "web-search", label: "Web search · Exa",
      description: "Neural web search for pages about this entity",
      inputTypes: ["domain", "ip", "person", "company", "email", "phone", "location", "url", "netblock", "as", "document"],
      needsKey: "exa",
    },
    async (e, keys) => {
      const key = keys.exa;
      if (!key) return { entities: [], links: [], note: "Exa API key missing — add it in Settings" };
      const j = await fetchJson("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({ query: e.value, numResults: 10 }),
      }, 30000);
      const results = Array.isArray(j?.results) ? j.results : [];
      const entities: Entity[] = [], links: Elink[] = [];
      for (const r of results.slice(0, 10)) {
        const url = String(r?.url || "");
        const title = String(r?.title || url).slice(0, 80);
        if (!url) continue;
        entities.push(mkEntity("url", url, "exa", {
          label: title.slice(0, 50),
          properties: { ...(r?.publishedDate ? { published: String(r.publishedDate).slice(0, 10) } : {}) },
          url,
        }));
        links.push({ from: e.id, to: entityId("url", url), label: "mentioned in" });
      }
      return { entities, links, note: `${entities.length} web results` };
    }
  ));

  return defs;
}



let _cache: TransformDef[] | null = null;
export async function getTransforms(): Promise<TransformDef[]> {
  if (!_cache) _cache = await buildTransforms();
  return _cache;
}

export async function transformsFor(type: EntityType): Promise<TransformDef[]> {
  return (await getTransforms()).filter((t) => t.inputTypes.includes(type));
}

export async function findTransform(key: string): Promise<TransformDef | undefined> {
  return (await getTransforms()).find((t) => t.key === key);
}

/** Geocode a place name → lat/lon via OpenStreetMap Nominatim (for location entities). */
export async function geocodePlace(q: string): Promise<{ lat: number; lon: number; display: string } | null> {
  try {
    const j = await fetchJson(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,
      {}, 15000);
    const r = Array.isArray(j) ? j[0] : j;
    if (!r || r.lat == null) return null;
    return { lat: Number(r.lat), lon: Number(r.lon), display: String(r.display_name || q).slice(0, 120) };
  } catch { return null; }
}
