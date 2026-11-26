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

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

export type EntityType =
  | "domain" | "ip" | "person" | "company" | "email" | "phone"
  | "location" | "url" | "netblock" | "as" | "document" | "note" | "wallet";

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
  wallet:   { label: "Wallet",        icon: "👛", color: "#D35400" },
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
  // Business-data classification (mirrors SOURCE_DEFS.business in sources.ts):
  // true when the transform emits business entities — companies, legal
  // entities, organizations, filings, registries, business places. False
  // for infrastructure, research, personal, and general-web transforms.
  // Every transform must carry an explicit value; the registry test fails
  // any future transform that omits it, so Milton business-only recon
  // never silently gains a non-business source.
  business?: boolean;
  needsKey?: string;                 // key id from keys.ts, when required
  disabled?: string;                 // reason: offered nowhere, run refused;
                                     // code stays intact so re-enable is one field
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
      business: false,
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
      business: false,
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
      business: false,
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
      business: false,
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
      business: false,
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

  // ---------- ip → risk verdict (IP99) ----------
  // Keyless. Time-decaying risk score with an evidence taxonomy
  // (proxy/vpn/dialup_pool/cloud_phone/hijacked_proxy) + evidence_state triage.
  // The score measures evidence freshness, not P(attacker): the verdict is
  // always presented behind evidence_state, and a 0 is never "clean".
  // Licensing: IP99 asks consumers to "query at decision time; do not cache
  // verdicts", so the score is marked point-in-time and every run re-queries
  // live — Meridian keeps no standing copy of IP99 data.
  // Anonymous quota: 500/day + 60/min per client IP (HTTP 429 on exhaustion).
  defs.push(await safeRun(
    {
      key: "ip-risk", label: "IP risk \u00b7 IP99",
      description: "Time-decaying risk verdict with evidence taxonomy for this IP (proxy/vpn/hijacked signals). Point-in-time \u2014 re-run for a fresh verdict.",
      inputTypes: ["ip"],
      business: false,
    },
    async (e) => {
      let j: any;
      try {
        j = await fetchJson(`https://ip99.com/v1/ip/${encodeURIComponent(e.value)}`, {}, 15000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "IP99 anonymous quota exhausted (500/day, 60/min per IP) \u2014 retry later" };
        }
        throw err;
      }
      if (!j || typeof j !== "object") return { entities: [], links: [], note: "no data for this IP" };
      const risk = (j.risk && typeof j.risk === "object") ? j.risk : {};
      const net = (j.network && typeof j.network === "object") ? j.network : {};
      const geo = (j.geo && typeof j.geo === "object") ? j.geo : {};
      const score = Number.isFinite(Number(risk.score)) ? Number(risk.score) : 0;
      const level = String(risk.level || "unknown");
      const estate = String(j.evidence_state || "unknown");
      const signals = Array.isArray(risk.signals) ? risk.signals.map((x: any) => String(x)).filter(Boolean) : [];
      const props: Record<string, string> = {
        risk: `${score} (${level})`,
        evidence: estate, // verdict lives behind evidence_state; 0 is never "clean"
        freshness: "point-in-time \u2014 re-run for a current verdict",
      };
      if (signals.length) props.signals = signals.slice(0, 6).join(", ").slice(0, 120);
      if (net.usage_type) props.usage = String(net.usage_type).slice(0, 40);
      if (net.asn != null) props.asn = String(net.asn);
      const geoLabel = [geo.city, geo.region, geo.country].filter(Boolean).join(", ");
      if (geoLabel) props.geo = geoLabel.slice(0, 80);
      if (j.computed_at) props.observed = String(j.computed_at).slice(0, 25);
      const entities: Entity[] = [mkEntity("ip", e.value, "ip99", {
        properties: props,
        lat: Number.isFinite(Number(geo.lat)) ? Number(geo.lat) : undefined,
        lon: Number.isFinite(Number(geo.lon)) ? Number(geo.lon) : undefined,
      })];
      const links: Elink[] = [];
      if (net.asn != null && String(net.asn).trim() !== "") {
        const asn = String(net.asn).toUpperCase().startsWith("AS") ? String(net.asn).toUpperCase() : `AS${net.asn}`;
        entities.push(mkEntity("as", asn, "ip99", { label: asn }));
        links.push({ from: e.id, to: entityId("as", asn), label: "announced by" });
      }
      if (geoLabel) {
        const extra: Partial<Entity> = { label: geoLabel.slice(0, 80), properties: {} };
        if (Number.isFinite(Number(geo.lat))) extra.lat = Number(geo.lat);
        if (Number.isFinite(Number(geo.lon))) extra.lon = Number(geo.lon);
        entities.push(mkEntity("location", geoLabel, "ip99", extra));
        links.push({ from: e.id, to: entityId("location", geoLabel), label: "geolocated to" });
      }
      return { entities, links, note: `risk ${score} (${level}) \u2014 ${estate}` };
    }
  ));

  // ---------- domain → DNS + cert footprint (IP99) ----------
  // Keyless. Passive DNS rows → ip entities; CT certs → document entities;
  // each cert fingerprint expands to sibling domains on the same cert
  // (same-cert phishing-cluster pivot). Caps keep the anonymous 500/day +
  // 60/min quota in check; a 429 anywhere yields the quota note.
  defs.push(await safeRun(
    {
      key: "domain-footprint", label: "DNS + certs \u00b7 IP99",
      description: "Passive DNS, certificate-transparency certs, and same-cert sibling domains for this domain",
      inputTypes: ["domain"],
      business: false,
    },
    async (e) => {
      const domain = e.value.toLowerCase();
      const quotaNote = "IP99 anonymous quota exhausted (500/day, 60/min per IP) \u2014 retry later";
      let quotaHit = false;
      const get = async (url: string): Promise<any | null> => {
        try {
          return await fetchJson(url, {}, 15000);
        } catch (err: any) {
          if (/HTTP 429/.test(String(err?.message || ""))) quotaHit = true;
          return null;
        }
      };
      const entities: Entity[] = [], links: Elink[] = [];
      const seenIp = new Set<string>(), seenDoc = new Set<string>(), seenDom = new Set<string>();
      // passive DNS
      const dns = await get(`https://ip99.com/v1/domain/dns/${encodeURIComponent(domain)}`);
      const rows = Array.isArray(dns?.data) ? dns.data : [];
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        const rrtype = String(r.rrtype || "").toUpperCase();
        const val = String(r.value || "").trim().replace(/\.$/, "");
        if (!val) continue;
        if ((rrtype === "A" || rrtype === "AAAA") && /^(\d{1,3}\.){3}\d{1,3}$/.test(val)) {
          if (seenIp.has(val) || seenIp.size >= 20) continue;
          seenIp.add(val);
          entities.push(mkEntity("ip", val, "ip99", {
            properties: {
              ...(r.first_seen ? { first_seen: String(r.first_seen).slice(0, 19) } : {}),
              ...(r.last_seen ? { last_seen: String(r.last_seen).slice(0, 19) } : {}),
              via: "IP99 passive DNS",
            },
          }));
          links.push({ from: e.id, to: entityId("ip", val), label: "resolved to" });
        } else if (rrtype === "CNAME" && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(val)) {
          const cn = val.toLowerCase();
          if (seenDom.has(cn) || seenDom.size >= 20) continue;
          seenDom.add(cn);
          entities.push(mkEntity("domain", cn, "ip99", { properties: { via: "IP99 passive DNS" } }));
          links.push({ from: e.id, to: entityId("domain", cn), label: "points to" });
        }
      }
      // CT certs → fingerprints → sibling domains
      const certs = await get(`https://ip99.com/v1/domain/certs/${encodeURIComponent(domain)}`);
      const certRows = Array.isArray(certs?.data) ? certs.data.slice(0, 5) : [];
      const fpJobs: Array<Promise<any>> = [];
      for (const c of certRows) {
        if (!c || typeof c !== "object") continue;
        const fp = String(c.fingerprint || "").toLowerCase();
        if (!/^[0-9a-f]{32,128}$/.test(fp) || seenDoc.has(fp)) continue;
        seenDoc.add(fp);
        const docVal = `${domain} cert ${fp.slice(0, 16)}`;
        entities.push(mkEntity("document", docVal, "ip99", {
          label: `cert ${fp.slice(0, 16)}\u2026`,
          properties: {
            fingerprint: fp,
            ...(c.issuer_org ? { issuer: String(c.issuer_org).slice(0, 60) } : {}),
            ...(c.log_source ? { log: String(c.log_source).slice(0, 40) } : {}),
            ...(c.not_before ? { not_before: String(c.not_before).slice(0, 19) } : {}),
          },
        }));
        links.push({ from: e.id, to: entityId("document", docVal), label: "issued cert" });
        fpJobs.push(get(`https://ip99.com/v1/domain/fingerprint/${fp}`));
      }
      const sibs = await Promise.all(fpJobs);
      for (const s of sibs) {
        for (const d of (Array.isArray(s?.data) ? s.data : [])) {
          if (!d || typeof d !== "object") continue;
          const name = String(d.domain || "").trim().toLowerCase().replace(/^\*\./, "");
          if (!name || name === domain || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(name)) continue;
          if (seenDom.has(name) || seenDom.size >= 40) continue;
          seenDom.add(name);
          entities.push(mkEntity("domain", name, "ip99", {
            properties: {
              ...(d.wildcard ? { wildcard: "yes" } : {}),
              ...(d.first_seen ? { first_seen: String(d.first_seen).slice(0, 19) } : {}),
              ...(d.last_seen ? { last_seen: String(d.last_seen).slice(0, 19) } : {}),
              via: "same certificate",
            },
          }));
          links.push({ from: e.id, to: entityId("domain", name), label: "shares cert with" });
        }
      }
      if (quotaHit && entities.length === 0) return { entities: [], links: [], note: quotaNote };
      const bits = [];
      if (seenIp.size) bits.push(`${seenIp.size} resolved IPs`);
      if (seenDoc.size) bits.push(`${seenDoc.size} certs`);
      if (seenDom.size) bits.push(`${seenDom.size} linked domains`);
      return { entities, links, note: bits.length ? bits.join(", ") : (quotaHit ? quotaNote : "no IP99 footprint") };
    }
  ));


  // ---------- company → LEI records (GLEIF name search) ----------
  defs.push(await safeRun(
    {
      key: "company-gleif", label: "Legal entities · GLEIF",
      description: "Search the global LEI registry by company name, with parent links",
      inputTypes: ["company"],
      business: true,
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
      business: true,
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
      business: true,
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

  // CompanyData.com.cy — keyless JSON API over the Cyprus Registrar of Companies
  // (data.gov.cy open-data export, DRCOR, CC BY 4.0). Verified live 2026-10-22.
  // DISABLED 2026-10-28: endpoint withdrawn (HTTP 404 since 2026-10-26,
  // re-checked 2026-10-28); code intact, re-enable by dropping the field
  // once companydata.com.cy/api/search recovers. Greek status/position
  // strings mapped where known; unknown values pass through raw so new
  // registry values never break the run.
const CDCY_STATUS_EN: Record<string, string> = {
  "Εγγεγραμμένη": "registered",
  "Διαγραμμένη": "struck off",
  "Στάληκε επιστολή Υπενθύμισης": "reminder letter sent",
};

const CDCY_POSITION_EN: Record<string, string> = {
  "Γραμματέας": "secretary",
  "Διευθυντής": "director",
};

const CDCY_ORG_RE = /\b(ltd|limited|llc|inc|corp|services|holdings|partners|trust|plc|sarl|gmbh)\b/i;

// ---------- company → Cyprus registry (CompanyData.com.cy) ----------
defs.push(await safeRun(
  {
    key: "company-cyprus", label: "Cyprus registry · CompanyData.com.cy",
    description: "Cyprus Registrar of Companies via CompanyData.com.cy: registered-office address, officers, status. Keyless, official open data.",
    inputTypes: ["company"],
      business: true,
    disabled: "Upstream endpoint withdrawn (HTTP 404 since 2026-10-26); re-enable when companydata.com.cy/api/search recovers.",
  },
  async (e) => {
    const s = await fetchJson(
      `https://companydata.com.cy/api/search?q=${encodeURIComponent(e.value)}`, {}, 25000);
    const results = Array.isArray(s?.results) ? s.results : [];
    const entities: Entity[] = [], links: Elink[] = [];
    const seenCompanies = new Set<string>();
    const seenOfficers = new Set<string>();
    const seenPlaces = new Set<string>();

    for (const r of results.slice(0, 6)) {
      const regNo = String(r?.registration_no || "").trim();
      const typeCode = String(r?.type_code || "").trim();
      const name = String(r?.name || "").slice(0, 90);
      const cid = `${regNo}-${typeCode}`;
      if (!regNo || !typeCode || !name || seenCompanies.has(cid)) continue;
      seenCompanies.add(cid);

      // Detail is best-effort: the search row alone is still a useful hit.
      let d: any = null;
      try {
        d = await fetchJson(`https://companydata.com.cy/api/companies/${cid}`, {}, 25000);
        if (d?.error) d = null;
      } catch { /* fall through with the search row */ }

      const statusRaw = String(d?.status ?? r?.status ?? "");
      const status = CDCY_STATUS_EN[statusRaw] || statusRaw;
      const registeredOn = String(d?.registered_on ?? r?.registered_on ?? "").slice(0, 10);
      const addr = d?.address || {};
      const territory = String(addr?.territory || "").trim();
      const street = String(addr?.street || "").trim();
      const props: Record<string, string> = {
        registration_no: regNo,
        status,
        ...(registeredOn ? { registered_on: registeredOn } : {}),
        ...(territory ? { address: territory } : {}),
        ...(d?.source?.data_as_of ? { registry_data_as_of: String(d.source.data_as_of).slice(0, 10) } : {}),
      };
      const compEnt = mkEntity("company", name, "companydata-cy", {
        properties: props,
        url: `https://companydata.com.cy/companies/${cid}`,
      });
      entities.push(compEnt);
      links.push({ from: e.id, to: compEnt.id, label: "registered in Cyprus" });

      if (territory && !seenPlaces.has(territory)) {
        seenPlaces.add(territory);
        const label = `${territory}${street ? ` — ${street}` : ""}`.slice(0, 90);
        entities.push(mkEntity("location", territory, "companydata-cy", {
          label, properties: { ...(street ? { street } : {}), via: "Cyprus company registry" },
        }));
        links.push({ from: compEnt.id, to: entityId("location", territory), label: "registered office in" });
      }

      for (const o of (Array.isArray(d?.officials) ? d.officials : [])) {
        const oname = String(o?.name || "").slice(0, 90);
        if (!oname || seenOfficers.has(oname)) continue;
        seenOfficers.add(oname);
        const posRaw = String(o?.position || "");
        const pos = CDCY_POSITION_EN[posRaw] || posRaw;
        const otype: EntityType = CDCY_ORG_RE.test(oname) ? "company" : "person";
        const oent = mkEntity(otype, oname, "companydata-cy", {
          properties: { ...(pos ? { position: pos } : {}), via: "Cyprus company registry" },
          url: `https://companydata.com.cy/companies/${cid}`,
        });
        entities.push(oent);
        links.push({ from: compEnt.id, to: oent.id, label: pos ? `officer (${pos})` : "officer" });
      }
    }
    return { entities, links, note: `${entities.length} registry hits` };
  }
));

  // ---------- company → manufacturers (SUDOKN / NSF Open Knowledge Network) ----------
  defs.push(await safeRun(
    {
      key: "company-sudokn", label: "Manufacturers · SUDOKN",
      description: "US small/medium manufacturers: street addresses, geo, NAICS, certifications, capabilities",
      inputTypes: ["company"],
      business: true,
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

  // ---------- company → trade registers (TradeRegister.fi / Coragrid) ----------
  // Keyless JSON API over 62 connected trade registers (traderegister.fi).
  // Verified live 2026-11-05: search + profile return real records;
  // officers endpoint returns the documented OfficerPage shape (empty
  // data[] for the companies sampled — officers are sparse in the free
  // tier, so the mapping is defensive and an empty list is a normal hit).
  // API Terms (2026:1), Oct 2026: free use in internal business
  // operations and own products, provided company data is shown as
  // "Powered by Coragrid" wherever displayed; 60/min per client address
  // (429 + Retry-After); no bulk copying to build a competing service or
  // redistribute as a dataset, no AI training, no presenting records as
  // official extracts. This transform is per-company on-demand only, shows
  // the attribution on every entity, and never claims a street address
  // (the API carries region-level geography only).
  const TR_ORG_RE = /\b(ltd|limited|llc|inc|corp|services|holdings|partners|trust|plc|sarl|gmbh|oy|ab|as|bv|nv|sa|ag)\b/i;
  defs.push(await safeRun(
    {
      key: "company-traderegister", label: "Trade register · TradeRegister.fi",
      description: "Trade registers in 62 countries via TradeRegister.fi (Coragrid): status, legal form, identifiers, industry, current officers. Keyless, attribution: Powered by Coragrid.",
      inputTypes: ["company"],
      business: true,
    },
    async (e) => {
      const q = e.value.trim().slice(0, 64);
      if (q.length < 3)
        return { entities: [], links: [], note: "company name too short for trade register search (min 3 characters)" };
      let s: any;
      try {
        s = await fetchJson(
          `https://api.traderegister.fi/v1/search?q=${encodeURIComponent(q)}&limit=5`, {}, 25000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "TradeRegister.fi rate limit (60/min) — retry shortly" };
        }
        throw err;
      }
      const results = Array.isArray(s?.data) ? s.data : [];
      if (!results.length) return { entities: [], links: [], note: "no trade register matches" };
      const entities: Entity[] = [], links: Elink[] = [];
      const seenCompanies = new Set<string>();
      const seenOfficers = new Set<string>();
      let companyCount = 0, officerCount = 0;
      for (const r of results.slice(0, 5)) {
        const id = String(r?.id || "").trim();
        const name = String(r?.name || "").slice(0, 90);
        if (!id || !name || seenCompanies.has(id)) continue;
        seenCompanies.add(id);
        // Detail is best-effort: the search row alone is still a useful hit.
        let d: any = null;
        try {
          d = await fetchJson(`https://api.traderegister.fi/v1/companies/${encodeURIComponent(id)}`, {}, 25000);
          if (d?.data) d = d.data;
          else if (d && typeof d === "object" && d.object !== "company") d = null;
        } catch { /* fall through with the search row */ }
        const rec = d && typeof d === "object" ? d : r;
        const status = String(rec?.lifecycle?.status || rec?.company_status || "").trim();
        const legalForm = String(rec?.legal_form || "").trim();
        const country = String(rec?.country_code || "").trim();
        const industry = String(rec?.industry || "").trim();
        const asOf = String(rec?.as_of_date || "").slice(0, 10);
        const regId = (Array.isArray(rec?.identifiers) ? rec.identifiers : [])
          .map((x: any) => String(x?.value || "").trim()).find(Boolean) || "";
        const canonical = String(rec?.lifecycle?.canonical_id || "").trim();
        const props: Record<string, string> = {
          ...(status ? { status } : {}),
          ...(legalForm ? { legal_form: legalForm } : {}),
          ...(country ? { country } : {}),
          ...(regId ? { registry_id: regId } : {}),
          ...(industry ? { industry } : {}),
          ...(asOf ? { registry_data_as_of: asOf } : {}),
          ...(canonical && canonical !== id ? { canonical_id: canonical } : {}),
          via: "TradeRegister.fi (Powered by Coragrid)",
        };
        const compEnt = mkEntity("company", name, "traderegister", {
          properties: props,
          url: `https://api.traderegister.fi/v1/companies/${encodeURIComponent(id)}`,
        });
        entities.push(compEnt);
        links.push({ from: e.id, to: compEnt.id, label: "registered as" });
        companyCount++;
        // Officers are best-effort: a failed fetch means "no officers shown".
        let officers: any[] = [];
        try {
          const o = await fetchJson(`https://api.traderegister.fi/v1/companies/${encodeURIComponent(id)}/officers`, {}, 25000);
          officers = Array.isArray(o?.data) ? o.data : [];
        } catch { /* no officers shown */ }
        for (const o of officers.slice(0, 10)) {
          const oname = String(o?.name || "").slice(0, 90);
          if (!oname || seenOfficers.has(oname.toLowerCase())) continue;
          seenOfficers.add(oname.toLowerCase());
          const roles = (Array.isArray(o?.roles) ? o.roles : []).map((x: any) => String(x)).filter(Boolean);
          const appointed = String(o?.appointed_on || "").slice(0, 10);
          const resigned = String(o?.resigned_on || "").slice(0, 10);
          const src = (o?.source && typeof o.source === "object") ? o.source : {};
          const otype: EntityType = TR_ORG_RE.test(oname) ? "company" : "person";
          const oent = mkEntity(otype, oname, "traderegister", {
            properties: {
              ...(roles.length ? { roles: roles.slice(0, 4).join(", ").slice(0, 120) } : {}),
              ...(appointed ? { appointed_on: appointed } : {}),
              ...(resigned ? { resigned_on: resigned } : {}),
              ...(src.system ? { officer_source: String(src.system).slice(0, 60) } : {}),
              ...(src.observed_at ? { observed_at: String(src.observed_at).slice(0, 25) } : {}),
              via: "TradeRegister.fi (Powered by Coragrid)",
            },
            url: `https://api.traderegister.fi/v1/companies/${encodeURIComponent(id)}`,
          });
          entities.push(oent);
          links.push({ from: compEnt.id, to: oent.id, label: roles[0] ? `officer (${roles[0].slice(0, 40)})` : "officer" });
          officerCount++;
        }
      }
      return { entities, links, note: `${companyCount} companies, ${officerCount} officers` };
    }
  ));

  // ---------- company → Open Company Graph (locaihost) ----------
  // Keyless JSON API joining 19 official open company registries
  // (graph.locaihost.org). Verified live 2026-11-11: search, company
  // detail and domain lookup all return 200 with no key; the Equinor
  // sample shows status, legal form, LEI, industry codes, employees, and
  // a domains[] list with per-domain confidence + evidence method.
  // "The API answers without a key at a modest rate limit. A key raises
  // the limit." (launch post, dev.to, 2026-11-05). No people data by
  // design — organisations only, directors/officers dropped at load.
  // Geography is town/postcode-level only: no street-address field
  // exists, so none is claimed. Monthly rebuild, not real-time; only
  // ~0.4% of orgs have a confirmed website, so the domain pivot fires
  // for that slice. Per-record source + licence kept.
  const OCG_BASE = "https://graph.locaihost.org";
  const OCG_VIA = "Open Company Graph (graph.locaihost.org)";
  function ocgProps(rec: any): Record<string, string> {
    const status = String(rec?.status || "").trim();
    const legalForm = String(rec?.legal_form || "").trim();
    const country = String(rec?.country || "").trim();
    const city = String(rec?.city || "").trim();
    const postcode = String(rec?.postcode || "").trim();
    const lei = String(rec?.lei || "").trim();
    const incorporated = String(rec?.incorporated || "").slice(0, 10);
    const number = String(rec?.number || "").trim();
    const ind = rec?.industry && typeof rec.industry === "object" ? rec.industry : null;
    const indCodes = (Array.isArray(ind?.codes) ? ind.codes : []).map((c: any) => String(c)).filter(Boolean).slice(0, 3);
    const indText = String(ind?.text || "").trim();
    const industry = ind ? [indCodes.join(", "), indText].filter(Boolean).join(" — ").slice(0, 120) : "";
    const employees = Number.isFinite(Number(rec?.employees)) ? String(Number(rec.employees)) : "";
    return {
      ...(status ? { status } : {}),
      ...(legalForm ? { legal_form: legalForm } : {}),
      ...(country ? { country } : {}),
      ...(city ? { city } : {}),
      ...(postcode ? { postcode } : {}),
      ...(number ? { registry_id: number } : {}),
      ...(lei ? { lei } : {}),
      ...(incorporated ? { incorporated } : {}),
      ...(industry ? { industry } : {}),
      ...(employees ? { employees } : {}),
      via: OCG_VIA,
    };
  }
  function ocgCompanyEnt(name: string, rec: any, extraProps: Record<string, string> = {}): Entity {
    const pageUrl = String(rec?.url || "").trim();
    const recordUrl = rec?.source && typeof rec.source === "object" ? String(rec.source.record_url || "") : "";
    return mkEntity("company", name, "opencograph", {
      properties: { ...ocgProps(rec), ...extraProps },
      url: recordUrl || pageUrl || undefined,
    });
  }
  async function ocgDetail(id: string): Promise<any | null> {
    try {
      const d = await fetchJson(`${OCG_BASE}/api/v1/company/${encodeURIComponent(id)}`, {}, 25000);
      return d && typeof d === "object" && !Array.isArray(d) ? d : null;
    } catch { return null; }
  }
  defs.push(await safeRun(
    {
      key: "company-opencograph", label: "Company graph · Open Company Graph",
      description: "19 open company registries joined (Open Company Graph, locaihost): status, legal form, LEI, industry, employees, confirmed websites. Keyless.",
      inputTypes: ["company"],
      business: true,
    },
    async (e) => {
      const q = e.value.trim().slice(0, 64);
      if (q.length < 3)
        return { entities: [], links: [], note: "company name too short for Open Company Graph search (min 3 characters)" };
      let s: any;
      try {
        s = await fetchJson(
          `${OCG_BASE}/api/v1/search?q=${encodeURIComponent(q)}&limit=5`, {}, 25000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "Open Company Graph rate limit — retry shortly" };
        }
        throw err;
      }
      const results = Array.isArray(s?.results) ? s.results : [];
      if (!results.length) return { entities: [], links: [], note: "no Open Company Graph matches" };
      const entities: Entity[] = [], links: Elink[] = [];
      const seenCompanies = new Set<string>();
      const seenDomains = new Set<string>();
      let companyCount = 0, domainCount = 0;
      for (const r of results.slice(0, 5)) {
        const id = String(r?.id || "").trim();
        const name = String(r?.name || "").slice(0, 90);
        if (!id || !name || seenCompanies.has(id)) continue;
        seenCompanies.add(id);
        // Detail is best-effort: the search row alone is still a useful hit.
        const d = await ocgDetail(id);
        const rec = d || r;
        const compEnt = ocgCompanyEnt(name, rec);
        entities.push(compEnt);
        links.push({ from: e.id, to: compEnt.id, label: "registered as" });
        companyCount++;
        // Confirmed websites come from the detail record only.
        const domains = Array.isArray(d?.domains) ? d.domains : [];
        for (const dom of domains.slice(0, 5)) {
          const host = String(dom?.domain || "").trim().toLowerCase();
          if (!host || seenDomains.has(host)) continue;
          seenDomains.add(host);
          const conf = Number(dom?.confidence);
          const methods = (Array.isArray(dom?.evidence) ? dom.evidence : [])
            .map((x: any) => String(x?.method || "")).filter(Boolean);
          const dent = mkEntity("domain", host, "opencograph", {
            properties: {
              ...(Number.isFinite(conf) ? { confidence: String(conf) } : {}),
              ...(methods.length ? { website_evidence: methods.slice(0, 2).join(", ").slice(0, 80) } : {}),
              via: OCG_VIA,
            },
            url: `https://${host}`,
          });
          entities.push(dent);
          links.push({ from: compEnt.id, to: dent.id, label: "website" });
          domainCount++;
        }
      }
      return { entities, links, note: `${companyCount} companies, ${domainCount} websites` };
    }
  ));

  // ---------- domain → companies behind it (Open Company Graph) ----------
  defs.push(await safeRun(
    {
      key: "domain-opencograph", label: "Companies behind domain · Open Company Graph",
      description: "Companies behind a domain via Open Company Graph (locaihost): registry matches with confidence + evidence method. Keyless. Only fires for the ~205K companies with a confirmed website.",
      inputTypes: ["domain"],
      business: true,
    },
    async (e) => {
      const host = e.value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].slice(0, 128);
      if (host.length < 4 || !host.includes("."))
        return { entities: [], links: [], note: "not a domain (need a host like example.com)" };
      let s: any;
      try {
        s = await fetchJson(`${OCG_BASE}/api/v1/domain?domain=${encodeURIComponent(host)}`, {}, 25000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "Open Company Graph rate limit — retry shortly" };
        }
        throw err;
      }
      const results = Array.isArray(s?.results) ? s.results : [];
      if (!results.length) return { entities: [], links: [], note: "no companies behind this domain in Open Company Graph" };
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      let n = 0;
      for (const r of results.slice(0, 5)) {
        const id = String(r?.id || "").trim();
        const name = String(r?.name || "").slice(0, 90);
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        // Detail is best-effort: the domain row alone is still a useful hit.
        const d = await ocgDetail(id);
        const rec = d || r;
        const conf = Number(r?.confidence);
        const ent = ocgCompanyEnt(name, rec, {
          ...(Number.isFinite(conf) ? { domain_confidence: String(conf) } : {}),
          ...(String(r?.method || "").trim() ? { website_evidence: String(r.method).trim().slice(0, 80) } : {}),
        });
        entities.push(ent);
        links.push({ from: e.id, to: ent.id, label: "owned by" });
        n++;
      }
      return { entities, links, note: `${n} companies behind this domain` };
    }
  ));

  // ---------- person → papers (OpenAlex) ----------
  // Key-aware (needsKey "openalex"): key sent as the `api_key` query
  // param on both calls when configured; without a key the URLs are
  // byte-identical to the original and it runs on the shared anonymous
  // allowance (429 → daily-budget note).
defs.push(await safeRun(
  {
    key: "person-papers", label: "Research · OpenAlex",
    description: "Papers and affiliations for this researcher (OpenAlex). Works without a key on the shared anonymous daily budget; a free key in Settings raises the allowance.",
    inputTypes: ["person"],
    business: false,
    needsKey: "openalex",
  },
  async (e, keys) => {
    const key = (keys.openalex || "").trim();
    const suffix = key ? `&api_key=${encodeURIComponent(key)}` : "";
    let j: any;
    try {
      j = await fetchJson(
        `https://api.openalex.org/authors?search=${encodeURIComponent(e.value)}&per-page=5${suffix}`, {}, 25000);
    } catch (err: any) {
      if (/HTTP 429/.test(String(err?.message || ""))) {
        return { entities: [], links: [], note: "OpenAlex daily budget exhausted (shared anonymous allowance) — add a free key in Settings or retry after midnight UTC" };
      }
      throw err;
    }
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
        `https://api.openalex.org/works?filter=authorships.author.id:${aid}&per-page=8&select=title,publication_year${suffix}`, {}, 25000)
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
      business: false,
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
      business: true,
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
      business: false,
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

  // ---------- location → notable places (Wikimedia Geo local index) ----------
  defs.push(await safeRun(
    {
      key: "wikimedia-geo", label: "Notable places · Wikimedia",
      description: "QRank-ranked notable places from a local CC0 Wikidata/OSM index (one-time setup, see README)",
      inputTypes: ["location"],
      business: false,
    },
    async (e) => {
      if (e.lat == null || e.lon == null)
        return { entities: [], links: [], note: "location has no coordinates" };
      const dbPath = wikimediaGeoDbPath();
      if (!dbPath)
        return { entities: [], links: [], note: "Wikimedia Geo index not configured — see README “Wikimedia Geo setup” (MERIDIAN_WIKIMEDIA_DB)" };
      const R_KM = 50;
      const dLat = R_KM / 111.32;
      const dLon = R_KM / (111.32 * Math.cos(e.lat * Math.PI / 180));
      const lat0 = e.lat - dLat, lat1 = e.lat + dLat;
      const lon0 = e.lon - dLon, lon1 = e.lon + dLon;
      // 1° grid cells spanned by the bbox: cell = (floor(lat)+90)*360 + (floor(lon)+180)
      const cells: number[] = [];
      for (let la = Math.floor(lat0); la <= Math.floor(lat1); la++)
        for (let lo = Math.floor(lon0); lo <= Math.floor(lon1); lo++)
          cells.push((la + 90) * 360 + (lo + 180));
      const db = new Database(dbPath, { readonly: true });
      let rows: Array<{ qid: string; label: string; lat: number; lon: number; qrank: number | null; url: string | null }>;
      try {
        rows = db.query(
          `SELECT qid, label, lat, lon, qrank, url FROM places
           WHERE cell IN (${cells.map(() => "?").join(",")})
             AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
           ORDER BY qrank DESC LIMIT 80`
        ).all(...cells, lat0, lat1, lon0, lon1) as typeof rows;
      } finally {
        db.close();
      }
      const havKm = (a: number, b: number, c: number, d: number) => {
        const R = 6371, t = Math.PI / 180;
        const s = Math.sin((c - a) * t / 2) ** 2
          + Math.cos(a * t) * Math.cos(c * t) * Math.sin((d - b) * t / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };
      const entities: Entity[] = [], links: Elink[] = [];
      for (const r of rows) {
        if (!r.qid || !r.label) continue;
        if (havKm(e.lat, e.lon, r.lat, r.lon) > R_KM) continue;
        const id = `location:${String(r.qid).toLowerCase()}`; // deterministic per Wikidata item
        entities.push({
          id, type: "location", value: r.label,
          label: r.label.slice(0, 60),
          properties: {
            qid: r.qid,
            ...(r.qrank != null ? { qrank: String(Math.round(r.qrank)) } : {}),
            via: "Wikimedia Geo (CC0)",
          },
          source: "wikimedia-geo",
          lat: r.lat, lon: r.lon,
          url: r.url || `https://www.wikidata.org/wiki/${r.qid}`,
        });
        links.push({ from: e.id, to: id, label: "notable nearby" });
        if (entities.length >= 25) break;
      }
      return { entities, links, note: `${entities.length} notable places within ${R_KM} km (QRank-ranked)` };
    }
  ));

  // ---------- any → web search (Exa) ----------
  defs.push(await safeRun(
    {
      key: "web-search", label: "Web search · Exa",
      description: "Neural web search for pages about this entity",
      inputTypes: ["domain", "ip", "person", "company", "email", "phone", "location", "url", "netblock", "as", "document"],
      business: false,
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

  // ---------- company → registry records (CompanyRegistryAPI.com / Coragrid) ----------
  // Keyless JSON API over the Coragrid company registers
  // (companyregistryapi.com). Verified live 2026-11-26: prefix search on
  // name or business ID + profile + current officers all return 200 with
  // no key; officers carry real names, roles (e.g. Jednatel), appointed_on
  // and a source system + URL + observed_at. 60/min per client address
  // (429 + Retry-After). API Terms: show "Powered by Coragrid" wherever
  // data is displayed; no bulk copying to build a competing service or
  // redistribute as a dataset, no AI training, no presenting records as
  // official extracts. This transform is per-company on-demand only, shows
  // the attribution on every entity, and never claims a street address
  // (the API carries region-level operating geography only).
  // Shape note: company_status is an OBJECT {category, local_name} here
  // (traderegister.fi returns a plain string) — category wins, and
  // lifecycle.status is NOT the company status: live proof is EQUINOR A S,
  // lifecycle "active" but company_status category "inactive".
  // Officers are names from public registers (personal data).
  defs.push(await safeRun(
    {
      key: "company-companyregistry", label: "Company registry · CompanyRegistryAPI.com",
      description: "Company registers via CompanyRegistryAPI.com (Coragrid): status, legal form, registry ID, industry, current officers. Keyless, attribution: Powered by Coragrid. Officers are names from public registers. No street addresses in this API.",
      inputTypes: ["company"],
      business: true,
    },
    async (e) => {
      const q = e.value.trim().slice(0, 64);
      if (q.length < 3)
        return { entities: [], links: [], note: "company name too short for company registry search (min 3 characters)" };
      let s: any;
      try {
        s = await fetchJson(
          `https://api.companyregistryapi.com/v1/search?q=${encodeURIComponent(q)}&limit=5`, {}, 25000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "CompanyRegistryAPI.com rate limit (60/min) — retry shortly" };
        }
        throw err;
      }
      const results = Array.isArray(s?.data) ? s.data : [];
      if (!results.length) return { entities: [], links: [], note: "no CompanyRegistryAPI.com matches" };
      const entities: Entity[] = [], links: Elink[] = [];
      const seenCompanies = new Set<string>();
      const seenOfficers = new Set<string>();
      let companyCount = 0, officerCount = 0;
      for (const r of results.slice(0, 5)) {
        const id = String(r?.id || "").trim();
        const name = String(r?.name || "").slice(0, 90);
        if (!id || !name || seenCompanies.has(id)) continue;
        seenCompanies.add(id);
        // Detail is best-effort: the search row alone is still a useful hit.
        let d: any = null;
        try {
          d = await fetchJson(`https://api.companyregistryapi.com/v1/companies/${encodeURIComponent(id)}`, {}, 25000);
          if (d?.data) d = d.data;
          else if (d && typeof d === "object" && d.object !== "company") d = null;
        } catch { /* fall through with the search row */ }
        const rec = d && typeof d === "object" ? d : r;
        const cs = rec?.company_status;
        const status = typeof cs === "string" ? cs.trim()
          : (cs && typeof cs === "object" ? String(cs.category || cs.local_name || "").trim() : "");
        const legalForm = String(rec?.legal_form || "").trim();
        const country = String(rec?.country_code || "").trim();
        const industry = String(rec?.industry || "").trim();
        const geography = String(rec?.operating_geography || "").trim();
        const asOf = String(rec?.as_of_date || "").slice(0, 10);
        const regId = (Array.isArray(rec?.identifiers) ? rec.identifiers : [])
          .map((x: any) => String(x?.value || "").trim()).find(Boolean) || "";
        const props: Record<string, string> = {
          ...(status ? { status } : {}),
          ...(legalForm ? { legal_form: legalForm } : {}),
          ...(country ? { country } : {}),
          ...(regId ? { registry_id: regId } : {}),
          ...(industry ? { industry } : {}),
          ...(geography ? { geography } : {}),
          ...(asOf ? { registry_data_as_of: asOf } : {}),
          via: "CompanyRegistryAPI.com (Powered by Coragrid)",
        };
        const compEnt = mkEntity("company", name, "companyregistry", {
          properties: props,
          url: `https://api.companyregistryapi.com/v1/companies/${encodeURIComponent(id)}`,
        });
        entities.push(compEnt);
        links.push({ from: e.id, to: compEnt.id, label: "registered as" });
        companyCount++;
        // Officers are best-effort: a failed fetch means "no officers shown".
        let officers: any[] = [];
        try {
          const o = await fetchJson(`https://api.companyregistryapi.com/v1/companies/${encodeURIComponent(id)}/officers`, {}, 25000);
          officers = Array.isArray(o?.data) ? o.data : [];
        } catch { /* no officers shown */ }
        for (const o of officers.slice(0, 10)) {
          const oname = String(o?.name || "").slice(0, 90);
          if (!oname || seenOfficers.has(oname.toLowerCase())) continue;
          seenOfficers.add(oname.toLowerCase());
          const roles = (Array.isArray(o?.roles) ? o.roles : []).map((x: any) => String(x)).filter(Boolean);
          const appointed = String(o?.appointed_on || "").slice(0, 10);
          const resigned = String(o?.resigned_on || "").slice(0, 10);
          const src = (o?.source && typeof o.source === "object") ? o.source : {};
          const otype: EntityType = TR_ORG_RE.test(oname) ? "company" : "person";
          const oent = mkEntity(otype, oname, "companyregistry", {
            properties: {
              ...(roles.length ? { roles: roles.slice(0, 4).join(", ").slice(0, 120) } : {}),
              ...(appointed ? { appointed_on: appointed } : {}),
              ...(resigned ? { resigned_on: resigned } : {}),
              ...(src.system ? { officer_source: String(src.system).slice(0, 60) } : {}),
              ...(src.observed_at ? { observed_at: String(src.observed_at).slice(0, 19) } : {}),
              via: "CompanyRegistryAPI.com (Powered by Coragrid)",
            },
            url: `https://api.companyregistryapi.com/v1/companies/${encodeURIComponent(id)}`,
          });
          entities.push(oent);
          links.push({ from: compEnt.id, to: oent.id, label: roles[0] ? `officer (${roles[0].slice(0, 40)})` : "officer" });
          officerCount++;
        }
      }
      return { entities, links, note: `${companyCount} companies, ${officerCount} officers` };
    }
  ));

  // ---------- company → EU company registry (W System) ----------
  // Keyless JSON API over 8 official EU registers (FR SIRENE, NO
  // Brønnøysund, FI YTJ, CZ ARES, PL KRS, EE, SK RPO, BE KBO) + a GLEIF
  // LEI fallback (wsystem.dev/eu-company-registry-api). Verified live
  // 2026-11-26: /company?q=DANONE&country=FR&limit=5 returns national-
  // register rows (street address, VAT ID, status_normalized "active",
  // revenue); /company?q=DANONE&limit=5 returns GLEIF LEI rows instead.
  // The transform only has a company name — no country — so it calls
  // without &country and therefore covers LEI holders only; the code
  // handles both shapes (national-register rows carry richer fields) and
  // says so in the note when results are LEI-sourced. Keyless limits:
  // 120/min, 500/day per IP. [address-data] — this API returns street
  // addresses, emitted as location entities. No lat/lon fields exist in
  // the response, so none are claimed. legal_form is an opaque registry
  // code (e.g. FR "5599"), stored as legal_form_code, not a readable form.
  // LEI-sourced status is the LEI record's status, not the business
  // register's — flagged in status_source, never presented as a register
  // verdict. Employees "NN" is the SIRENE unknown sentinel, skipped.
  defs.push(await safeRun(
    {
      key: "company-wsystem", label: "EU company registry · W System",
      description: "EU company registry via W System [address-data]: street address, VAT ID, status, legal form, activity, LEI. Keyless (120/min, 500/day per IP). Without a country the search covers LEI holders only (GLEIF fallback); national-register lookups (FR, NO, FI, CZ, PL, EE, SK, BE) need a country.",
      inputTypes: ["company"],
      business: true,
    },
    async (e) => {
      const q = e.value.trim().slice(0, 64);
      if (q.length < 3)
        return { entities: [], links: [], note: "company name too short for W System search (min 3 characters)" };
      let s: any;
      try {
        s = await fetchJson(
          `https://api.wsystem.dev/company?q=${encodeURIComponent(q)}&limit=5`, {}, 25000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "W System rate limit (120/min, 500/day per IP) — retry shortly" };
        }
        throw err;
      }
      if (s && typeof s === "object" && typeof s.error === "string" && s.error)
        return { entities: [], links: [], note: `W System error: ${s.error.slice(0, 120)}` };
      const results = Array.isArray(s?.results) ? s.results : [];
      if (!results.length)
        return { entities: [], links: [], note: "no W System matches (without a country, search covers LEI holders only)" };
      const entities: Entity[] = [], links: Elink[] = [];
      const seenCompanies = new Set<string>();
      const seenPlaces = new Set<string>();
      let companyCount = 0, locationCount = 0, leiSourced = 0;
      for (const r of results.slice(0, 5)) {
        const name = String(r?.name || "").slice(0, 90);
        const country = String(r?.country || "").trim();
        const regId = String(r?.registry_id || "").trim();
        if (!name) continue;
        const dedupKey = regId ? `${country}:${regId}` : name.toLowerCase();
        if (seenCompanies.has(dedupKey)) continue;
        seenCompanies.add(dedupKey);
        const status = String(r?.status_normalized || "").trim();
        const origin = String(r?.origin || "").trim();
        if (origin === "lei_index") leiSourced++;
        const source = String(r?.source || "").trim();
        const legalFormCode = String(r?.legal_form || "").trim();
        const vatId = String(r?.vat_id || "").trim();
        const activityCode = String(r?.activity_code || "").trim();
        const activity = String(r?.activity || "").trim();
        const registeredOn = String(r?.registration_date || "").slice(0, 10);
        const employees = String(r?.employees ?? "").trim();
        const lei = String(r?.lei || "").trim();
        const website = String(r?.website || "").trim();
        const revenue = Number(r?.revenue_eur);
        const netIncome = Number(r?.net_income_eur);
        const dataAsOf = String(r?.data_as_of || "").slice(0, 10);
        const props: Record<string, string> = {
          ...(status ? { status } : {}),
          ...(origin === "lei_index"
            ? { status_source: "GLEIF LEI index (LEI status, not register status)" }
            : source ? { status_source: source.slice(0, 80) } : {}),
          ...(country ? { country } : {}),
          ...(regId ? { registry_id: regId } : {}),
          ...(legalFormCode ? { legal_form_code: legalFormCode } : {}),
          ...(vatId ? { vat_id: vatId } : {}),
          ...(activityCode ? { activity_code: activityCode } : {}),
          ...(activity ? { activity: activity.slice(0, 120) } : {}),
          ...(registeredOn ? { registered_on: registeredOn } : {}),
          ...(employees && employees !== "NN" ? { employees } : {}),
          ...(lei ? { lei } : {}),
          ...(website ? { website } : {}),
          ...(Number.isFinite(revenue) ? { revenue_eur: String(revenue) } : {}),
          ...(Number.isFinite(netIncome) ? { net_income_eur: String(netIncome) } : {}),
          ...(dataAsOf ? { registry_data_as_of: dataAsOf } : {}),
          via: "W System EU Company Registry",
        };
        const sourceUrl = String(r?.source_url || "").trim();
        const compEnt = mkEntity("company", name, "wsystem", {
          properties: props,
          url: sourceUrl || undefined,
        });
        entities.push(compEnt);
        links.push({ from: e.id, to: compEnt.id, label: "registered as" });
        companyCount++;
        const address = String(r?.address || "").trim();
        if (address && !seenPlaces.has(address.toLowerCase())) {
          seenPlaces.add(address.toLowerCase());
          const city = String(r?.city || "").trim();
          const postal = String(r?.postal_code || "").trim();
          entities.push(mkEntity("location", address, "wsystem", {
            label: address.slice(0, 80),
            properties: {
              ...(city ? { city } : {}),
              ...(postal ? { postal } : {}),
              ...(country ? { country } : {}),
              via: "W System EU Company Registry",
            },
          }));
          links.push({ from: compEnt.id, to: entityId("location", address), label: "located at" });
          locationCount++;
        }
      }
      const leiNote = leiSourced > 0 && leiSourced === companyCount
        ? " — LEI-index matches only (status is LEI status, not register status)"
        : "";
      return { entities, links, note: `${companyCount} companies, ${locationCount} addresses${leiNote}` };
    }
  ));

  // ---------- company → Japan verification record (RegBase) ----------
  // Keyless JSON API for Ed25519-signed company verification records
  // (regbase.local-connect-design.trade). Verified live 2026-11-26:
  // /health returns {status, key_id, listed_records: 3808, daily_cap: 3000};
  // GET /record/1180301018771 returns the signed Toyota record
  // (company_name, listed_status, securities_code 72030, EDINET code
  // E02144, issued_at, signature, key_id). /openapi.json confirms there
  // is NO name-search endpoint — only /records POST, /record/{number}
  // GET, /verify POST, /health GET — so this transform is number-based:
  // a 13-digit corporate number fetches the record, anything else gets
  // instructions instead of a fetch. Free sandbox covers ONLY the 3,808
  // EDINET-listed companies, under a shared daily cap of 3,000; unknown
  // numbers answer 404. No street address exists in this API. A signature
  // attests issuer + integrity only, never the truth of the claims.
  defs.push(await safeRun(
    {
      key: "company-regbase", label: "Japan verification · RegBase",
      description: "Ed25519-signed Japan company verification records via RegBase (keyless). Number-based only — enter the 13-digit corporate number; no name search exists. Free sandbox covers only 3,808 EDINET-listed companies (shared daily cap 3,000). No street addresses.",
      inputTypes: ["company"],
      business: true,
    },
    async (e) => {
      const num = e.value.trim();
      if (!/^\d{13}$/.test(num))
        return { entities: [], links: [], note: "RegBase needs the 13-digit Japanese corporate number (e.g. Toyota 1180301018771) — it has no name search; free sandbox covers only 3,808 EDINET-listed companies" };
      let rec: any;
      try {
        rec = await fetchJson(`https://regbase.local-connect-design.trade/record/${num}`, {}, 25000);
      } catch (err: any) {
        const msg = String(err?.message || "");
        if (/HTTP 404/.test(msg))
          return { entities: [], links: [], note: "no RegBase record for this corporate number — free sandbox covers only 3,808 EDINET-listed companies" };
        if (/HTTP 429/.test(msg))
          return { entities: [], links: [], note: "RegBase daily cap reached (3,000 shared requests/day) — retry later" };
        throw err;
      }
      const claims = Array.isArray(rec?.claims) ? rec.claims : [];
      const byField = new Map<string, any>();
      for (const c of claims) {
        if (c && typeof c === "object" && typeof c.field === "string" && !byField.has(c.field)) byField.set(c.field, c);
      }
      const val = (f: string): string => {
        const c = byField.get(f);
        return c && c.value != null ? String(c.value).trim() : "";
      };
      const name = val("company_name").slice(0, 90);
      if (!name) return { entities: [], links: [], note: "RegBase record has no company_name claim" };
      const sig = (rec?.signature && typeof rec.signature === "object") ? rec.signature : {};
      const sigAlgo = String(sig.algorithm || "").trim();
      const sigKey = String(sig.key_id || "").trim();
      const issuedAt = String(rec?.issued_at || "").slice(0, 25);
      const props: Record<string, string> = {
        corporate_number: num,
        ...(val("listed_status") ? { listed_status: val("listed_status").slice(0, 60) } : {}),
        ...(val("securities_code") ? { securities_code: val("securities_code") } : {}),
        ...(val("edinet_code") ? { edinet_code: val("edinet_code") } : {}),
        ...(issuedAt ? { issued_at: issuedAt } : {}),
        ...(sigAlgo || sigKey ? { signature: [sigAlgo, sigKey ? `key ${sigKey}` : ""].filter(Boolean).join(" · ").slice(0, 80) } : {}),
        via: "RegBase Japan — Ed25519-signed sandbox record",
      };
      const ent = mkEntity("company", name, "regbase", {
        properties: props,
        url: `https://regbase.local-connect-design.trade/record/${num}`,
      });
      return {
        entities: [ent],
        links: [{ from: e.id, to: ent.id, label: "verified as" }],
        note: `signed RegBase record: ${name}`,
      };
    }
  ));

// meridian — batch C: 5 new transforms + wallet entity type.
// SNIPPET FILE ONLY — do not run as-is. The coordinator pastes:
//   • Section A into src/transforms.ts (EntityType union + ENTITY_TYPES)
//   • Section B into buildTransforms() in src/transforms.ts, before
//     `return defs;` (any order; domain/ip/wallet/phone groupings kept)
//   • tests-snippet.ts into src/transforms.test.ts
// All code follows the existing safeRun / fetchJson / mkEntity / entityId
// pattern. Every transform carries an explicit `business` boolean.
// Live-verification status (2026-11-26, curl): see the delivery report.
//   crt.name ✓ 200 · vpndetection ✓ 200 · ironflow ✓ 200 (fills+liquidations)
//   freespy ✓ 200 · helius: docs-verified only (keyed, no live call possible)

// =====================================================================
// SECTION A — wallet entity type
// Paste into src/transforms.ts:
//   1. add "wallet" to the EntityType union
//   2. add the wallet row to ENTITY_TYPES
// Do NOT touch detectEntityType (users pick "wallet" from the type dropdown).
// =====================================================================

// --- A1: EntityType union (current) ---
// export type EntityType =
//   | "domain" | "ip" | "person" | "company" | "email" | "phone"
//   | "location" | "url" | "netblock" | "as" | "document" | "note";

// --- A1: EntityType union (new — add "wallet") ---
// export type EntityType =
//   | "domain" | "ip" | "person" | "company" | "email" | "phone"
//   | "location" | "url" | "netblock" | "as" | "document" | "note" | "wallet";

// --- A2: ENTITY_TYPES record (new row; insert after the `note` row) ---
//   wallet: { label: "Wallet", icon: "👛", color: "#D35400" },

// =====================================================================
// SECTION B — the 5 transforms (each a complete defs.push(await safeRun(...)))
// =====================================================================

  // ---------- domain → subdomains (crt.name CT index) ----------
  // Keyless. GET https://crt.name/v1/search?apex={domain}&dates=1 returns
  // PLAIN TEXT, one "name<TAB>first-seen-ISO" line per subdomain (no dates
  // param = bare names). Verified live 2026-11-26: HTTP 200, 3,089 lines
  // for example.com, first line "example.com\t2009-07-03T20:37:11Z".
  // Homepage: "Free public API: 100 requests per IP per day, no token
  // required." 5.8B names indexed. Names are HISTORICAL (never deleted):
  // output includes long-dead hosts — resolve before presenting as live.
  // Uses raw fetch + .text(), NOT fetchJson (the body is not JSON).
  defs.push(await safeRun(
    {
      key: "domain-crtname", label: "Subdomains · crt.name",
      description: "Certificate-transparency subdomain index (crt.name, 5.8B names, keyless, 100/day/IP). Historical — includes long-dead hosts; resolve before treating as live.",
      inputTypes: ["domain"],
      business: false,
    },
    async (e) => {
      const domain = e.value.toLowerCase().trim();
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain))
        return { entities: [], links: [], note: "not a domain (need a host like example.com)" };
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      let text: string;
      try {
        const r = await fetch(
          `https://crt.name/v1/search?apex=${encodeURIComponent(domain)}&dates=1`,
          { headers: { "User-Agent": "meridian-osint/2.0" }, signal: ctrl.signal });
        if (r.status === 429)
          return { entities: [], links: [], note: "crt.name rate limit (100/day per IP) — retry tomorrow" };
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        text = await r.text();
      } finally { clearTimeout(t); }
      const entities: Entity[] = [], links: Elink[] = [];
      const seen = new Set<string>();
      for (const line of text.split("\n")) {
        if (entities.length >= 40) break;
        const [rawName, rawDate] = line.split("\t");
        const name = String(rawName || "").trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
        if (!name || name === domain || seen.has(name)) continue;
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(name)) continue;
        seen.add(name);
        const firstSeen = String(rawDate || "").trim().slice(0, 10);
        entities.push(mkEntity("domain", name, "crtname", {
          properties: {
            ...(firstSeen ? { first_seen: firstSeen } : {}),
            via: "crt.name CT index (historical)",
          },
        }));
        links.push({ from: e.id, to: entityId("domain", name), label: "subdomain of" });
      }
      return { entities, links, note: `${entities.length} subdomains in crt.name (historical — resolve before treating as live)` };
    }
  ));

  // ---------- ip → VPN/Tor/relay flags (VPNDetection) ----------
  // Keyless. GET https://api.vpndetection.io/{ip} verified live 2026-11-26:
  // HTTP 200 JSON, no key — {ip, is_bogon, is_vpn, is_relay, is_tor,
  // is_anycast, location{continent,country,timezone,currency}, asn{asn,
  // name, domain, type, prefix, country, rpki_status}, hostname}.
  // Free plan "Unlimited", commercial use allowed; no redistribution, no
  // competing service. Anonymous responses carry NO is_bot field and NO
  // named-VPN-operator / confidence / last-seen fields (paid-only) — the
  // code only reads flags that are actually present, and never claims them.
  defs.push(await safeRun(
    {
      key: "ip-vpndetection", label: "VPN / Tor check · VPNDetection",
      description: "VPN, Tor, relay, anycast and bogon flags plus ASN + location for this IP (VPNDetection, keyless)",
      inputTypes: ["ip"],
      business: true,
    },
    async (e) => {
      let j: any;
      try {
        j = await fetchJson(`https://api.vpndetection.io/${encodeURIComponent(e.value)}`, {}, 15000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "VPNDetection rate limit — retry shortly" };
        }
        throw err;
      }
      if (!j || typeof j !== "object" || !j.ip)
        return { entities: [], links: [], note: "no data for this IP" };
      const flag = (k: string): string | undefined =>
        typeof j[k] === "boolean" ? (j[k] ? "yes" : "no") : undefined;
      const props: Record<string, string> = {};
      for (const [k, pk] of [["is_vpn", "vpn"], ["is_tor", "tor"], ["is_relay", "relay"],
        ["is_anycast", "anycast"], ["is_bogon", "bogon"], ["is_bot", "bot"]] as const) {
        const v = flag(k);
        if (v !== undefined) props[pk] = v;
      }
      const asn = j.asn && typeof j.asn === "object" ? j.asn : {};
      const loc = j.location && typeof j.location === "object" ? j.location : {};
      if (asn.asn != null) props.asn = String(asn.asn).toUpperCase().startsWith("AS") ? String(asn.asn).toUpperCase() : `AS${asn.asn}`;
      if (asn.name) props.asn_name = String(asn.name).slice(0, 60);
      if (asn.type) props.asn_type = String(asn.type).slice(0, 40);
      if (asn.prefix) props.prefix = String(asn.prefix);
      if (asn.rpki_status) props.rpki = String(asn.rpki_status).slice(0, 20);
      if (j.hostname) props.hostname = String(j.hostname).slice(0, 80);
      const geoLabel = [loc.country_name || loc.country, loc.continent_name || loc.continent].filter(Boolean).join(", ");
      if (geoLabel) props.geo = geoLabel.slice(0, 80);
      if (loc.timezone) props.timezone = String(loc.timezone).slice(0, 40);
      const entities: Entity[] = [mkEntity("ip", e.value, "vpndetection", { properties: props })];
      const links: Elink[] = [];
      if (asn.asn != null && String(asn.asn).trim() !== "") {
        const asnVal = String(asn.asn).toUpperCase().startsWith("AS") ? String(asn.asn).toUpperCase() : `AS${asn.asn}`;
        entities.push(mkEntity("as", asnVal, "vpndetection", {
          label: asnVal,
          properties: { ...(asn.name ? { name: String(asn.name).slice(0, 60) } : {}) },
        }));
        links.push({ from: e.id, to: entityId("as", asnVal), label: "announced by" });
      }
      if (geoLabel) {
        entities.push(mkEntity("location", geoLabel, "vpndetection", {
          label: geoLabel.slice(0, 80),
          properties: {
            ...(loc.country ? { country: String(loc.country).toUpperCase() } : {}),
            ...(loc.timezone ? { timezone: String(loc.timezone).slice(0, 40) } : {}),
            ...(loc.currency_code ? { currency: String(loc.currency_code).slice(0, 10) } : {}),
          },
        }));
        links.push({ from: e.id, to: entityId("location", geoLabel), label: "located in" });
      }
      const verdict = [props.vpn === "yes" ? "VPN" : null, props.tor === "yes" ? "Tor" : null,
        props.relay === "yes" ? "relay" : null].filter(Boolean).join(" + ") || "no VPN/Tor/relay flags";
      return { entities, links, note: `${verdict} (${props.asn || "unknown ASN"})` };
    }
  ));

  // ---------- wallet → Hyperliquid fills (Ironflow) ----------
  // Keyless (1 credit/read; 100 credits/day keyless, last 24h only, 60s
  // behind live). Hyperliquid ONLY.
  // INPUT DESIGN (docs-verified 2026-11-26): wallet, NOT a market symbol.
  // The docs page (https://ironflow.sh/data-api) gives the wallet query
  // explicitly — "Every fill for one wallet, any market:
  // curl \"https://api.ironflow.sh/v1/fills?address=0xYourWallet&limit=100\""
  // — and a live probe of /v1/fills?address=0x01535f…&limit=2 returned
  // HTTP 200 with real fill rows. /v1/liquidations takes a market param
  // and has NO documented address param (a live probe with address=
  // returned HTTP 200 but empty data for a wallet with a known
  // liquidation, so it is not trusted as a wallet query). One fill row
  // carries the queried wallet's own address, so counterparty wallet
  // entities are emitted only defensively, when a row's address differs
  // from the input (normally none — the address-scoped query returns
  // only the queried wallet's fills).
  defs.push(await safeRun(
    {
      key: "wallet-fills", label: "Hyperliquid fills · Ironflow",
      description: "Recent Hyperliquid fills for this wallet via Ironflow (keyless, 1 credit; last 24h only, 60s behind live). Hyperliquid-only.",
      inputTypes: ["wallet"],
      business: true,
    },
    async (e) => {
      const addr = e.value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr))
        return { entities: [], links: [], note: "not an Ethereum wallet address (need 0x + 40 hex chars)" };
      let j: any;
      try {
        j = await fetchJson(
          `https://api.ironflow.sh/v1/fills?address=${encodeURIComponent(addr)}&limit=10`, {}, 20000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "Ironflow rate limit (100 credits/day keyless) — retry tomorrow" };
        }
        throw err;
      }
      const rows = Array.isArray(j?.data) ? j.data : [];
      if (!rows.length)
        return { entities: [], links: [], note: "no Hyperliquid fills for this wallet in the last 24h (keyless window)" };
      const entities: Entity[] = [], links: Elink[] = [];
      const seenDoc = new Set<string>(), seenWallet = new Set<string>();
      for (const r of rows.slice(0, 10)) {
        if (!r || typeof r !== "object") continue;
        const hash = String(r.hash || "").trim();
        const tid = String(r.tid || r.oid || "").trim();
        const docVal = hash || (tid ? `fill-${tid}` : "");
        if (!docVal || seenDoc.has(docVal)) continue;
        seenDoc.add(docVal);
        const market = String(r.market || r.display_symbol || "").trim();
        const side = String(r.side || "").toLowerCase();
        const price = String(r.price || "").trim();
        const size = String(r.size || "").trim();
        const label = `${side || "fill"} ${size} ${market} @ ${price}`.slice(0, 60);
        const ts = Number(r.timestamp);
        const props: Record<string, string> = {
          ...(market ? { market } : {}),
          ...(side ? { side } : {}),
          ...(price ? { price } : {}),
          ...(size ? { size } : {}),
          ...(r.address ? { address: String(r.address).slice(0, 42) } : {}),
          ...(hash ? { hash: hash.slice(0, 66) } : {}),
          ...(r.block_number != null ? { block: String(r.block_number) } : {}),
          ...(Number.isFinite(ts) ? { timestamp: new Date(ts).toISOString().slice(0, 19) + "Z" } : {}),
          ...(r.realized_pnl != null ? { realized_pnl: String(r.realized_pnl).slice(0, 30) } : {}),
          ...(r.dir ? { direction: String(r.dir).slice(0, 40) } : {}),
          via: "Ironflow (Hyperliquid)",
        };
        entities.push(mkEntity("document", docVal, "ironflow", { label, properties: props }));
        links.push({ from: e.id, to: entityId("document", docVal), label: "filled" });
        const other = String(r.address || "").trim();
        if (other && other.toLowerCase() !== addr.toLowerCase() && !seenWallet.has(other.toLowerCase())) {
          seenWallet.add(other.toLowerCase());
          entities.push(mkEntity("wallet", other, "ironflow", {
            properties: { via: "Ironflow (Hyperliquid)" },
          }));
          links.push({ from: entityId("document", docVal), to: entityId("wallet", other), label: "filled against" });
        }
      }
      return { entities, links, note: `${seenDoc.size} Hyperliquid fills (last 24h, keyless)` };
    }
  ));

  // ---------- wallet → Solana tx history scan (Helius Parsed Events) ----------
  // KEYED-FREE: free plan $0/mo, 1M credits/mo, no card; key from the
  // Helius Dashboard, passed as the ?api-key= query param. needsKey:
  // "helius" (coordinator wires HELIUS_API_KEY into keys.ts/server.ts).
  // Docs: https://helius.dev/docs/parsed-events.md and
  // https://www.helius.dev/blog/parsed-events-scan (both read 2026-11-26).
  // POST https://mainnet.helius-rpc.com/v1/parsed-events/scan?api-key=…
  // body (real documented shape):
  //   { address, match: { mints: [{ mint }] }, tokenAccounts, limit,
  //     budget: { maxScannedTransactions }, sortOrder }
  // The match uses the NATIVE SOL pseudo-mint
  // So11111111111111111111111111111111111111111 (ends …11111 — distinct
  // from wrapped SOL …11112): per the docs it matches lamport changes,
  // not counting the fee, so the scan returns the wallet's general
  // activity without requiring the analyst to name a program or mint.
  // tokenAccounts "balanceChanged" catches transfers that touch only the
  // wallet's token accounts. Cost: 10 credits + 1 per history page
  // scanned (page = up to 1,000 txs); budget caps the scan at 1,000 txs
  // (≈11 credits max per run). Live API call NOT verifiable without a
  // key — docs-verified only; fixtures mirror the documented
  // TransactionResult shape from the quickstart.
  defs.push(await safeRun(
    {
      key: "wallet-helius", label: "Solana history · Helius",
      description: "Scan a Solana wallet's history for SOL/token activity via Helius Parsed Events Scan (keyed-free; 10 credits + 1/page scanned, capped at 1,000 txs ≈ 11 credits/run)",
      inputTypes: ["wallet"],
      business: true,
      needsKey: "helius",
    },
    async (e, keys) => {
      const key = keys.helius;
      if (!key) return { entities: [], links: [], note: "Helius API key missing — add it in Settings" };
      const addr = e.value.trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr))
        return { entities: [], links: [], note: "not a Solana wallet address (need 32–44 base58 chars)" };
      let j: any;
      try {
        j = await fetchJson(
          `https://mainnet.helius-rpc.com/v1/parsed-events/scan?api-key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              address: addr,
              match: { mints: [{ mint: "So11111111111111111111111111111111111111111" }] },
              tokenAccounts: "balanceChanged",
              limit: 10,
              budget: { maxScannedTransactions: 1000 },
              sortOrder: "desc",
            }),
          }, 30000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "Helius rate limit — retry shortly" };
        }
        throw err;
      }
      const rows = Array.isArray(j?.data) ? j.data : [];
      if (!rows.length)
        return { entities: [], links: [], note: "no matching Solana transactions for this wallet (scan budget 1,000 txs)" };
      const entities: Entity[] = [], links: Elink[] = [];
      const seenDoc = new Set<string>(), seenWallet = new Set<string>();
      for (const item of rows.slice(0, 10)) {
        if (!item || typeof item !== "object") continue;
        if (item.parserStatus && item.parserStatus !== "OK") continue;
        const parsed = (item.parsed && typeof item.parsed === "object") ? item.parsed : item;
        const sig = String(item.signature || parsed.signature || "").trim();
        if (!sig || seenDoc.has(sig)) continue;
        seenDoc.add(sig);
        const summary = (parsed.summary && typeof parsed.summary === "object") ? parsed.summary : {};
        const type = String(summary.type || "transaction").slice(0, 40);
        const instructions = Array.isArray(parsed.instructions) ? parsed.instructions : [];
        const first = instructions.find((x: any) => x && typeof x === "object") || {};
        const program = String(first.programName || first.programId || "").slice(0, 60);
        const blockTime = Number(parsed.blockTime);
        const props: Record<string, string> = {
          type,
          ...(program ? { program } : {}),
          ...(Number.isFinite(blockTime) ? { timestamp: new Date(blockTime * 1000).toISOString().slice(0, 19) + "Z" } : {}),
          ...(parsed.feePayer ? { fee_payer: String(parsed.feePayer).slice(0, 44) } : {}),
          via: "Helius Parsed Events",
        };
        const label = `${type} · ${sig.slice(0, 8)}…`.slice(0, 60);
        entities.push(mkEntity("document", sig, "helius", {
          label,
          properties: props,
          url: `https://solscan.io/tx/${sig}`,
        }));
        links.push({ from: e.id, to: entityId("document", sig), label: "in history" });
        const counterparties = new Map<string, string>(); // address -> link label
        for (const t of [...(Array.isArray(parsed.nativeTransfers) ? parsed.nativeTransfers : []),
          ...(Array.isArray(parsed.tokenTransfers) ? parsed.tokenTransfers : [])]) {
          if (!t || typeof t !== "object") continue;
          for (const a of [t.fromUserAccount, t.toUserAccount]) {
            const acct = String(a || "").trim();
            if (acct && acct !== addr && !counterparties.has(acct)) counterparties.set(acct, "transacted with");
          }
          const mint = String(t.mint || "").trim();
          if (mint && mint !== addr && !counterparties.has(mint)) counterparties.set(mint, "touched mint");
        }
        for (const [acct, linkLabel] of counterparties) {
          if (seenWallet.has(acct) || seenWallet.size >= 20) continue;
          seenWallet.add(acct);
          entities.push(mkEntity("wallet", acct, "helius", {
            properties: { via: "Helius Parsed Events" },
          }));
          links.push({ from: entityId("document", sig), to: entityId("wallet", acct), label: linkLabel });
        }
      }
      const credits = j?.scan && typeof j.scan === "object" && j.scan.creditsCharged != null
        ? ` (scan cost ${j.scan.creditsCharged} credits)` : "";
      return { entities, links, note: `${seenDoc.size} matching Solana transactions${credits}` };
    }
  ));

  // ---------- phone → carrier / spam / geo (FreeSpy) ----------
  // Keyless. GET https://freespy.app/wp-json/freespy/v1/lookup/{number}
  // verified live 2026-11-26: HTTP 200 JSON, no key, no signup —
  // {formatted, e164, variants, type, country, location{city, state,
  // lat, lng, tz}, carrier{name, line_type}, community{total, negative,
  // …}, ftc, score{score, level, label, factors[{label, impact}]}}.
  // NANP/US-centric. community.names / carrier.caller_name are
  // DELIBERATELY ignored: a community-reported name is never wired as a
  // person entity.
  defs.push(await safeRun(
    {
      key: "phone-freespy", label: "Phone lookup · FreeSpy",
      description: "Carrier, line type, spam score and area-code geography for a NANP phone number (FreeSpy, keyless)",
      inputTypes: ["phone"],
      business: false,
    },
    async (e) => {
      const num = e.value.replace(/[^\d+]/g, "");
      if (num.replace(/\D/g, "").length < 7)
        return { entities: [], links: [], note: "not a phone number (need at least 7 digits)" };
      let j: any;
      try {
        j = await fetchJson(
          `https://freespy.app/wp-json/freespy/v1/lookup/${encodeURIComponent(num)}`, {}, 15000);
      } catch (err: any) {
        if (/HTTP 429/.test(String(err?.message || ""))) {
          return { entities: [], links: [], note: "FreeSpy rate limit — retry shortly" };
        }
        throw err;
      }
      if (!j || typeof j !== "object")
        return { entities: [], links: [], note: "no data for this number" };
      const carrier = (j.carrier && typeof j.carrier === "object") ? j.carrier : {};
      const score = (j.score && typeof j.score === "object") ? j.score : {};
      const community = (j.community && typeof j.community === "object") ? j.community : {};
      const loc = (j.location && typeof j.location === "object") ? j.location : {};
      const props: Record<string, string> = {};
      if (j.formatted) props.formatted = String(j.formatted).slice(0, 30);
      if (j.e164) props.e164 = String(j.e164).slice(0, 20);
      if (j.type_label || j.type) props.line_type = String(j.type_label || j.type).slice(0, 40);
      if (j.country) props.country = String(j.country).toUpperCase().slice(0, 10);
      if (j.valid === false) {
        props.valid = "no";
        if (j.reason_label || j.reason) props.invalid_reason = String(j.reason_label || j.reason).slice(0, 120);
      } else if (j.valid === true) props.valid = "yes";
      const carrierName = String(carrier.name || "").trim();
      if (carrierName) props.carrier = carrierName.slice(0, 60);
      const lineType = String(carrier.line_type_label || carrier.line_type || "").trim();
      if (lineType && lineType.toLowerCase() !== "unknown") props.carrier_line_type = lineType.slice(0, 40);
      if (score.score != null) {
        const sLabel = String(score.label || score.level || "").trim();
        props.spam_score = `${score.score}${sLabel ? ` (${sLabel})` : ""}`.slice(0, 60);
      }
      const factors = (Array.isArray(score.factors) ? score.factors : [])
        .map((f: any) => String(f?.label || "")).filter(Boolean);
      if (factors.length) props.spam_factors = factors.slice(0, 4).join("; ").slice(0, 160);
      if (community.total != null) {
        props.reports = `${community.total} total (${community.negative ?? 0} negative)`.slice(0, 60);
      }
      // NOTE: community.names / carrier.caller_name are never emitted as
      // person entities — community-reported names are unverified.
      const entities: Entity[] = [mkEntity("phone", e.value, "freespy", {
        properties: props,
        url: String(j.url || "").trim() || undefined,
      })];
      const links: Elink[] = [];
      const lat = Number(loc.lat), lon = Number(loc.lng ?? loc.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const city = String(loc.city || "").trim();
        const state = String(loc.state || "").trim();
        const locVal = [city, state].filter(Boolean).join(", ") || "area-code location";
        entities.push(mkEntity("location", locVal, "freespy", {
          label: locVal.slice(0, 80),
          properties: {
            ...(loc.tz ? { timezone: String(loc.tz).slice(0, 40) } : {}),
            ...(loc.tz_label ? { tz_label: String(loc.tz_label).slice(0, 20) } : {}),
            ...(loc.npa ? { area_code: String(loc.npa) } : {}),
            via: "FreeSpy area-code geography",
          },
          lat, lon,
        }));
        links.push({ from: e.id, to: entityId("location", locVal), label: "area code in" });
      }
      const spamBit = score.score != null ? `spam ${score.score}` : "no spam score";
      return { entities, links, note: `${j.formatted || e.value} — ${carrierName || "unknown carrier"}, ${spamBit}` };
    }
  ));

// =====================================================================
// PatentRef shared helpers — insert ONCE, before company-patents
// =====================================================================
// Spec: https://patentref.io/openapi.json (OpenAPI 3.1.0, v1.26.0, fetched
// live 2026-11-26; 706,061 bytes). PatentsView-compatible grammar: q/f/s/o
// are JSON params. q = one-key JSON object; operators _eq, _neq, _gt, _gte,
// _lt, _lte, _begins, _contains, _text_all, _text_any, _text_phrase take
// one (dotted) field; _and/_or take lists; _not takes one query. f = JSON
// list of fields (a nested group's name returns the whole group); s = JSON
// list of {field: "asc"|"desc"}; o = {"size": N} (default 100, max 1000;
// page with "after" — "offset" answers 400). Responses:
// {error: false, count, total_hits, patents|assignees|inventors: [...]}.
// Auth: X-Api-Key header; free key 1,000 req/mo + 45/min, self-serve at
// /api/v1/meta/signup/. NOTE: the nested "assignee"/"inventor" LINK fields
// are kind:none (no search field), so patents are found by _text_phrase on
// assignees.assignee_organization / inventors.inventor_name_first|last —
// never by assignee/inventor id.
const PR_BASE = "https://patentref.io/api/v1";
const PR_KEY_NOTE = "PatentRef API key missing — add it in Settings";

/** Keyed PatentRef GET (full URL). Maps HTTP statuses to user-facing notes. */
async function prGet(url: string, key: string): Promise<any> {
  try {
    return await fetchJson(url, { headers: { "X-Api-Key": key } }, 30000);
  } catch (err: any) {
    const m = String(err?.message || "");
    if (/HTTP 403/.test(m)) throw new Error("PatentRef key rejected (HTTP 403) — check the key in Settings");
    if (/HTTP 429/.test(m)) throw new Error("PatentRef rate limit (45/min, 1,000/mo) — retry shortly");
    if (/HTTP 501/.test(m)) throw new Error("PatentRef build does not carry this dataset yet (HTTP 501) — retry after the next weekly refresh");
    throw err;
  }
}

/** True when err is one of prGet's user-facing notes (return it, don't rethrow). */
function prFriendly(err: any): string | null {
  const m = String(err?.message || "");
  if (/^PatentRef (key rejected|rate limit|build does not)/.test(m)) return m;
  return null;
}

interface PrPatentParts {
  id: string; title: string; date: string;
  cpc: string[]; inventors: string[]; assignees: string[];
}

/** Parse one PatentRecord (f includes assignees, inventors, cpc_current). */
function prPatentParts(p: any): PrPatentParts {
  const id = String(p?.patent_id || "").trim();
  const title = String(p?.patent_title || "").trim();
  const date = String(p?.patent_date || "").slice(0, 10);
  const cpc = [...new Set((Array.isArray(p?.cpc_current) ? p.cpc_current : [])
    .map((c: any) => String(c?.cpc_subclass_id || "").trim()).filter(Boolean))].slice(0, 4);
  const inventors = [...new Set((Array.isArray(p?.inventors) ? p.inventors : [])
    .map((v: any) => [v?.inventor_name_first, v?.inventor_name_last]
      .map((x: any) => String(x || "").trim()).filter(Boolean).join(" "))
    .filter(Boolean))].slice(0, 8);
  const assignees = [...new Set((Array.isArray(p?.assignees) ? p.assignees : [])
    .map((a: any) => String(a?.assignee_organization || "").trim()
      || [a?.assignee_individual_name_first, a?.assignee_individual_name_last]
        .map((x: any) => String(x || "").trim()).filter(Boolean).join(" "))
    .filter(Boolean))];
  return { id, title, date, cpc, inventors, assignees };
}

/** One granted patent as a document entity. Value is the patent number. */
function prDocEntity(parts: PrPatentParts, assignee: string): Entity {
  const value = `US${parts.id}`;
  return mkEntity("document", value, "patentref", {
    label: parts.title ? parts.title.slice(0, 50) : value,
    properties: {
      ...(parts.title ? { title: parts.title.slice(0, 120) } : {}),
      ...(parts.date ? { grant_date: parts.date } : {}),
      ...(parts.cpc.length ? { cpc: parts.cpc.join(", ") } : {}),
      ...(assignee ? { assignee: assignee.slice(0, 80) } : {}),
    },
    url: `https://patentref.io/p/${parts.id}`,
  });
}

// ---------- company → patents (PatentRef) ----------
defs.push(await safeRun(
  {
    key: "company-patents", label: "Patents · PatentRef",
    description: "US patents granted to this assignee via PatentRef (PatentsView-compatible API, weekly refresh, 1976→now). Free key required.",
    inputTypes: ["company"],
    business: true,
    needsKey: "patentref",
  },
  async (e, keys) => {
    const key = keys.patentref;
    if (!key) return { entities: [], links: [], note: PR_KEY_NOTE };
    const q = JSON.stringify({ _text_phrase: { "assignees.assignee_organization": e.value } });
    const f = JSON.stringify(["patent_id", "patent_title", "patent_date", "assignees", "inventors", "cpc_current"]);
    const s = JSON.stringify([{ patent_date: "desc" }]);
    const o = JSON.stringify({ size: 10 });
    const url = `${PR_BASE}/patent/?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}&s=${encodeURIComponent(s)}&o=${encodeURIComponent(o)}`;
    let j: any;
    try {
      j = await prGet(url, key);
    } catch (err: any) {
      const note = prFriendly(err);
      if (note) return { entities: [], links: [], note };
      throw err;
    }
    const patents = Array.isArray(j?.patents) ? j.patents : [];
    if (!patents.length) return { entities: [], links: [], note: `no PatentRef patents found for assignee "${e.value}"` };
    const entities: Entity[] = [], links: Elink[] = [];
    const seenInv = new Set<string>();
    let docCount = 0;
    for (const p of patents.slice(0, 10)) {
      const parts = prPatentParts(p);
      if (!parts.id) continue;
      const assignee = parts.assignees[0] || e.value;
      const doc = prDocEntity(parts, assignee);
      entities.push(doc);
      links.push({ from: e.id, to: doc.id, label: "assignee on" });
      docCount++;
      for (const name of parts.inventors) {
        const pid = entityId("person", name);
        if (seenInv.has(pid)) {
          links.push({ from: doc.id, to: pid, label: "invented by" });
          continue;
        }
        if (seenInv.size >= 5) continue;
        seenInv.add(pid);
        entities.push(mkEntity("person", name, "patentref", {
          properties: { via: "US patent inventor" },
        }));
        links.push({ from: doc.id, to: pid, label: "invented by" });
      }
    }
    return { entities, links, note: `${docCount} patents for ${e.value} (${seenInv.size} inventors)` };
  }
));

// ---------- person → patents (PatentRef) ----------
defs.push(await safeRun(
  {
    key: "person-patents", label: "Patents · PatentRef",
    description: "US patents naming this inventor via PatentRef (1976→now). Inventor names are public-filing mentions from granted US patents. Free key required.",
    inputTypes: ["person"],
    business: false,
    needsKey: "patentref",
  },
  async (e, keys) => {
    const key = keys.patentref;
    if (!key) return { entities: [], links: [], note: PR_KEY_NOTE };
    const words = e.value.trim().split(/\s+/).filter(Boolean);
    const last = words.length ? words[words.length - 1] : "";
    const first = words.slice(0, -1).join(" ");
    if (!last) return { entities: [], links: [], note: "empty inventor name" };
    const q = first
      ? JSON.stringify({ _and: [
          { _text_phrase: { "inventors.inventor_name_first": first } },
          { _text_phrase: { "inventors.inventor_name_last": last } },
        ] })
      : JSON.stringify({ _text_phrase: { "inventors.inventor_name_last": last } });
    const f = JSON.stringify(["patent_id", "patent_title", "patent_date", "assignees", "inventors", "cpc_current"]);
    const s = JSON.stringify([{ patent_date: "desc" }]);
    const o = JSON.stringify({ size: 10 });
    const url = `${PR_BASE}/patent/?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}&s=${encodeURIComponent(s)}&o=${encodeURIComponent(o)}`;
    let j: any;
    try {
      j = await prGet(url, key);
    } catch (err: any) {
      const note = prFriendly(err);
      if (note) return { entities: [], links: [], note };
      throw err;
    }
    const patents = Array.isArray(j?.patents) ? j.patents : [];
    if (!patents.length) return { entities: [], links: [], note: `no PatentRef patents found for inventor "${e.value}"` };
    const entities: Entity[] = [], links: Elink[] = [];
    const seenCo = new Set<string>();
    let docCount = 0;
    for (const p of patents.slice(0, 10)) {
      const parts = prPatentParts(p);
      if (!parts.id) continue;
      const assignee = parts.assignees[0] || "";
      const doc = prDocEntity(parts, assignee);
      entities.push(doc);
      links.push({ from: e.id, to: doc.id, label: "inventor on" });
      docCount++;
      for (const org of parts.assignees) {
        const cid = entityId("company", org);
        if (seenCo.has(cid)) {
          links.push({ from: doc.id, to: cid, label: "assigned to" });
          continue;
        }
        if (seenCo.size >= 5) continue;
        seenCo.add(cid);
        entities.push(mkEntity("company", org, "patentref", {
          properties: { via: "US patent assignee" },
        }));
        links.push({ from: doc.id, to: cid, label: "assigned to" });
      }
    }
    return { entities, links, note: `${docCount} patents by ${e.value} (${seenCo.size} assignees)` };
  }
));

// ---------- company → papers (OpenAlex institutions + works) ----------
// NEW. needsKey "openalex" wires the key through when configured, but the
// transform degrades gracefully without it: anonymous OpenAlex requests
// run on the shared daily budget (100 credits/day demo allowance). Shapes
// are docs-verified — live checks 2026-11-26 hit HTTP 429 "daily_budget"
// (shared IP budget exhausted, resets midnight UTC), so the institutions
// + works fixtures in the tests mirror the documented shapes
// (institutions: id/display_name/type/country_code/works_count; works:
// title/publication_year/doi + authorships[].author.display_name).
// Only works + the institution entity itself are emitted (no author
// person entities).
defs.push(await safeRun(
  {
    key: "company-papers", label: "Research · OpenAlex institutions",
    description: "Papers from this organisation's researchers via OpenAlex: institution match + recent works. Works without a key on the shared anonymous daily budget; a free key in Settings raises the allowance.",
    inputTypes: ["company"],
    business: false,
    needsKey: "openalex",
  },
  async (e, keys) => {
    const key = (keys.openalex || "").trim();
    const suffix = key ? `&api_key=${encodeURIComponent(key)}` : "";
    let inst: any;
    try {
      inst = await fetchJson(
        `https://api.openalex.org/institutions?search=${encodeURIComponent(e.value)}&per-page=3${suffix}`, {}, 25000);
    } catch (err: any) {
      if (/HTTP 429/.test(String(err?.message || ""))) {
        return { entities: [], links: [], note: "OpenAlex daily budget exhausted (shared anonymous allowance) — add a free key in Settings or retry after midnight UTC" };
      }
      throw err;
    }
    const match = (Array.isArray(inst?.results) ? inst.results : [])[0];
    if (!match) return { entities: [], links: [], note: `no OpenAlex institution match for "${e.value}"` };
    const instId = String(match?.id || "").split("/").pop() || "";
    const name = String(match?.display_name || e.value).slice(0, 90);
    if (!instId) return { entities: [], links: [], note: `no OpenAlex institution match for "${e.value}"` };
    const props: Record<string, string> = {};
    if (match?.type) props.type = String(match.type).slice(0, 40);
    if (match?.country_code) props.country = String(match.country_code).toUpperCase();
    if (match?.works_count) props.works = Number(match.works_count).toLocaleString("en-US");
    const instEnt = mkEntity("company", name, "openalex", {
      properties: props, url: `https://openalex.org/${instId}`,
    });
    const entities: Entity[] = [instEnt];
    const links: Elink[] = [{ from: e.id, to: instEnt.id, label: "matched institution" }];
    let works: any = null, worksLimited = false;
    try {
      works = await fetchJson(
        `https://api.openalex.org/works?filter=authorships.institutions.id:${instId}&per-page=8&select=title,publication_year,doi${suffix}`, {}, 25000);
    } catch (err: any) {
      if (/HTTP 429/.test(String(err?.message || ""))) worksLimited = true;
    }
    for (const w of (Array.isArray(works?.results) ? works.results : []).slice(0, 8)) {
      const title = String(w?.title || "").slice(0, 80);
      if (!title) continue;
      const wid = entityId("document", title);
      entities.push(mkEntity("document", title, "openalex", {
        label: title.slice(0, 50),
        properties: {
          ...(w?.publication_year ? { year: String(w.publication_year) } : {}),
          ...(w?.doi ? { doi: String(w.doi).slice(0, 80) } : {}),
        },
      }));
      links.push({ from: instEnt.id, to: wid, label: "published" });
    }
    const nDocs = entities.filter((x) => x.type === "document").length;
    if (worksLimited) {
      return { entities, links, note: `${name}: institution matched, works lookup hit the OpenAlex daily budget — add a free key in Settings` };
    }
    return { entities, links, note: `${name}: ${nDocs} recent works` };
  }
));

// =====================================================================

// ---------- company → vendor incident history (Vendor History) ----------
// Keyless HTML pages only — no query API (/api, /data.json, /vendors.json,
// /vendor/{slug}.json all 404). Per-vendor page carries a schema.org
// Dataset JSON-LD block (name / description / licence CC BY 4.0 /
// dateModified) plus one <ol class="incidents"> per section; each
// <li class="incident"> has <time datetime>, <span class="tag tag-*">,
// a <p> summary and a <p class="src"> source link. Tag classes seen live:
//   tag-breach-notice, tag-sec-cyber-filing, tag-ransomware-claim,
//   tag-exploited-flaw (CISA KEV). Unknown tags are skipped, so new
// section kinds (e.g. outage reports) never leak into results.
defs.push(await safeRun(
  {
    key: "company-vendorhistory", label: "Vendor history · Vendor History",
    description: "Vendor incident history (Vendor History, CC BY 4.0): state breach notices, SEC 8-K cyber filings, ransomware-group claims and CISA KEV flaws. Curated 255-vendor scope — an empty result means 'not tracked', not 'safe'.",
    inputTypes: ["company"],
    business: true,
  },
  async (e) => {
    const pageUrl = `https://vendorhistory.com/vendor/${slug(e.value)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let status = 0, html = "";
    try {
      const r = await fetch(pageUrl, { headers: { "User-Agent": "meridian-osint/2.0" }, signal: ctrl.signal });
      status = r.status;
      if (r.ok) html = await r.text();
    } finally { clearTimeout(timer); }
    if (status === 404)
      return { entities: [], links: [], note: `not tracked by Vendor History — ${e.value} has no vendor page (curated 255-vendor scope; empty means 'not tracked', not 'safe')` };
    if (status === 429)
      return { entities: [], links: [], note: "Vendor History rate limit — retry shortly" };
    if (status !== 200 || !html)
      return { entities: [], links: [], note: `Vendor History request failed (HTTP ${status || "timeout"})` };

    // Summary date from the schema.org Dataset JSON-LD block (best-effort).
    let checked = "";
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i.exec(html);
    if (ld) {
      try {
        const graph = JSON.parse(ld[1]);
        const nodes = Array.isArray(graph?.["@graph"]) ? graph["@graph"] : [graph];
        const ds = nodes.find((n: any) => n && n["@type"] === "Dataset");
        if (ds?.dateModified) checked = String(ds.dateModified).slice(0, 10);
      } catch { /* summary is best-effort */ }
    }

    const clean = (s: string) => s.replace(/<[^>]+>/g, " ")
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

    const KIND: Record<string, { short: string; label: string; link: string; plural: string }> = {
      "tag-breach-notice": { short: "breach-notice", label: "Breach notice", link: "breach notice", plural: "breach notice(s)" },
      "tag-sec-cyber-filing": { short: "sec-filing", label: "SEC cyber filing", link: "SEC filing", plural: "SEC filing(s)" },
      "tag-ransomware-claim": { short: "ransomware-claim", label: "Ransomware claim (unconfirmed)", link: "ransomware claim (unconfirmed)", plural: "ransomware claim(s) (unconfirmed)" },
      "tag-exploited-flaw": { short: "kev-flaw", label: "Exploited flaw (CISA KEV)", link: "exploited flaw (CISA KEV)", plural: "exploited flaw(s) (CISA KEV)" },
    };
    const entities: Entity[] = [], links: Elink[] = [];
    const counts: Record<string, number> = {};
    const items = html.match(/<li class="incident">[\s\S]*?<\/li>/g) || [];
    for (const item of items) {
      if (entities.length >= 10) break;
      const tagClass = /tag-(breach-notice|sec-cyber-filing|ransomware-claim|exploited-flaw)/.exec(item)?.[1] || "";
      const kind = KIND[`tag-${tagClass}`];
      if (!kind) continue; // unknown section kind (e.g. outages) — skip
      const date = /<time datetime="([^"]+)"/.exec(item)?.[1]?.slice(0, 10) || "";
      const paras = [...item.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => clean(m[1]));
      const summary = paras[0] || "";
      const srcM = /<p class="src">[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(item);
      const srcUrl = srcM?.[1] || pageUrl;
      const srcName = srcM ? clean(srcM[2]) : "Vendor History";
      const cve = /CVE-\d{4}-\d{4,7}/.exec(summary)?.[0] || "";
      const value = `${e.value} ${kind.short} ${date}${cve ? ` ${cve}` : ""}`.trim();
      entities.push(mkEntity("document", value, "vendorhistory", {
        label: (cve || `${kind.label} ${date}`.trim()).slice(0, 60),
        properties: {
          kind: kind.label,
          ...(date ? { date } : {}),
          ...(srcName ? { source: srcName.slice(0, 60) } : {}),
          ...(summary ? { summary: summary.slice(0, 200) } : {}),
          ...(cve ? { cve } : {}),
          ...(kind.short === "ransomware-claim" ? { confirmed: "no — unconfirmed group claim" } : {}),
          attribution: "Vendor History (CC BY 4.0)",
        },
        url: srcUrl,
      }));
      links.push({ from: e.id, to: entityId("document", value), label: kind.link });
      counts[kind.short] = (counts[kind.short] || 0) + 1;
    }
    if (!entities.length)
      return { entities, links, note: `no breach notices, SEC filings, ransomware claims or KEV flaws listed for ${e.value} in Vendor History's sources${checked ? ` (checked ${checked})` : ""} — curated 255-vendor scope; empty means 'not tracked', not 'safe'` };
    const bits = Object.entries(counts).map(([k, n]) => {
      const kind = Object.values(KIND).find((v) => v.short === k);
      return `${n} ${kind?.plural || k}`;
    });
    return { entities, links, note: `${bits.join(", ")} for ${e.value} (Vendor History, CC BY 4.0${checked ? `, checked ${checked}` : ""})` };
  }
));

// ---------- company → CDR companies (Captain Drawdown) ----------
// Keyless JSON API. Verified live 2026-11-26: the full list is
// GET https://captaindrawdown.com/api/v1/companies.json → 200,
// {version, as_of, dataset, license: "CC BY-NC-SA 4.0", count, data: [...]}
// (count 1,062, 72 countries on 2026-11-26 — up from 913 / 65 in the
// brief). Per-company detail is /api/v1/companies/{slug}.json → {data: row}.
// Companies ONLY — the directory's researchers/people table is never read.
// Licence bars commercial reuse; the note is on every entity (via) and in
// the description.
defs.push(await safeRun(
  {
    key: "company-cdr", label: "CDR companies · Captain Drawdown",
    description: "Carbon-removal companies in the Captain Drawdown CDR Company Directory (1,062 companies, 72 countries): pathway, country, liveliness, size, registry. Keyless. Data CC BY-NC-SA 4.0 — non-commercial reuse only.",
    inputTypes: ["company"],
    business: true,
  },
  async (e) => {
    const q = e.value.trim().slice(0, 64);
    if (q.length < 3)
      return { entities: [], links: [], note: "company name too short for CDR directory search (min 3 characters)" };
    let list: any;
    try {
      list = await fetchJson("https://captaindrawdown.com/api/v1/companies.json", {}, 25000);
    } catch (err: any) {
      if (/HTTP 429/.test(String(err?.message || "")))
        return { entities: [], links: [], note: "Captain Drawdown rate limit — retry shortly" };
      throw err;
    }
    const rows = Array.isArray(list?.data) ? list.data : [];
    const needle = q.toLowerCase();
    const matches = rows.filter((r: any) => String(r?.name || "").toLowerCase().includes(needle)).slice(0, 5);
    if (!matches.length) return { entities: [], links: [], note: "no CDR directory matches" };
    const entities: Entity[] = [], links: Elink[] = [];
    for (const row of matches) {
      // Detail is best-effort (same row shape, wrapped in {data}); the
      // list row alone is still a useful hit.
      let rec: any = row;
      const rowSlug = String(row?.slug || "").trim();
      if (rowSlug) {
        try {
          const d = await fetchJson(`https://captaindrawdown.com/api/v1/companies/${encodeURIComponent(rowSlug)}.json`, {}, 15000);
          if (d && typeof d === "object" && d.data && typeof d.data === "object") rec = d.data;
        } catch { /* fall through with the list row */ }
      }
      const name = String(rec?.name || "").slice(0, 90);
      if (!name) continue;
      const pathway = [rec?.pathway_primary, rec?.pathway_secondary]
        .map((x: any) => String(x || "").trim()).filter(Boolean).join(" + ");
      const liveliness = String(rec?.liveliness_tier || "").trim();
      const score = Number.isFinite(Number(rec?.liveliness_score)) ? String(Number(rec.liveliness_score)) : "";
      entities.push(mkEntity("company", name, "captaindrawdown", {
        properties: {
          ...(pathway ? { pathway: pathway.slice(0, 80) } : {}),
          ...(rec?.country ? { country: String(rec.country).slice(0, 60) } : {}),
          ...(liveliness ? { liveliness: score ? `${liveliness} (${score})` : liveliness } : {}),
          ...(rec?.size_class ? { size: String(rec.size_class).slice(0, 40) } : {}),
          ...(rec?.registries ? { registry: String(rec.registries).slice(0, 80) } : {}),
          ...(rec?.description ? { description: String(rec.description).slice(0, 200) } : {}),
          via: "Captain Drawdown CDR Company Directory (CC BY-NC-SA 4.0)",
        },
        url: String(rec?.profile_url || "").trim() || undefined,
      }));
      links.push({ from: e.id, to: entityId("company", name), label: "listed in CDR directory" });
    }
    return { entities, links, note: `${entities.length} CDR ${entities.length === 1 ? "company" : "companies"} (CC BY-NC-SA 4.0 — non-commercial reuse only)` };
  }
));

// ---------- email → breach exposure (Orelys) ----------
// Keyless for the breach endpoints (docs.orelys.io: "The list of data
// breaches and the breach search are free, with no key").
// GET https://api.orelys.io/v1/breaches — VERIFIED LIVE 2026-11-26:
// HTTP 200, {count: 976, records: 28075767916, updated_at, breaches: [
// {id, name, logo_url, breach_date, added_date, records, data_types,
// reported_types, sensitive, unverified, claimed_by}]}.
// The API is BACK after being unreachable on 2026-11-26 (HTTP 000/403).
// POST /v1/breaches/check — DOCS-VERIFIED ONLY, not live-verified: a live
// liveness check with a dummy address timed out (TLS OK, 0 bytes in 30 s —
// the docs say a search takes up to ~45 s) and was NOT retried after the
// runtime approval for that call expired unanswered. Per the docs:
// POST, JSON body {email}, Content-Type: application/json, no key;
// response {breaches: [{name, breach_date, found_types}], hidden};
// 429/503 carry Retry-After, 504 is upstream_timeout; 10 searches/min
// per address; the address is never stored. Only breach names + data-type
// categories are ever emitted — never record values.
defs.push(await safeRun(
  {
    key: "email-orelys", label: "Breach exposure · Orelys",
    description: "Breach exposure for this email (Orelys, free, no key): which known data breaches hold the address, and which kinds of data leaked with it — breach names + data-type categories only, never record values. Check only addresses you are entitled to check.",
    inputTypes: ["email"],
    business: false,
  },
  async (e) => {
    const email = e.value.trim().slice(0, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return { entities: [], links: [], note: "not an email address" };
    let j: any;
    try {
      // Docs: a search takes up to ~45 s, so the client timeout is 60 s.
      j = await fetchJson("https://api.orelys.io/v1/breaches/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }, 60000);
    } catch (err: any) {
      if (/HTTP 429|HTTP 503|HTTP 504/.test(String(err?.message || "")))
        return { entities: [], links: [], note: "Orelys breach search rate limit / upstream timeout — retry shortly" };
      throw err;
    }
    const breaches = Array.isArray(j?.breaches) ? j.breaches : [];
    const hidden = Number(j?.hidden) || 0;
    const entities: Entity[] = [], links: Elink[] = [];
    for (const b of breaches.slice(0, 10)) {
      const name = String(b?.name || "").slice(0, 90);
      if (!name) continue;
      const date = String(b?.breach_date || "").slice(0, 10);
      const types = (Array.isArray(b?.found_types) ? b.found_types : []).map((x: any) => String(x)).filter(Boolean);
      const value = date ? `${name} (${date})` : name;
      entities.push(mkEntity("document", value, "orelys", {
        label: name.slice(0, 60),
        properties: {
          ...(date ? { breach_date: date } : {}),
          ...(types.length ? { data_types: types.slice(0, 12).join(", ").slice(0, 160) } : {}),
          exposure: "email found in breach — names + data-type categories only, never record values",
        },
      }));
      links.push({ from: e.id, to: entityId("document", value), label: "exposed in" });
    }
    if (!entities.length)
      return { entities, links, note: "no known breaches hold this address (Orelys catalogue)" };
    const hiddenBit = hidden > 0 ? ` (+ ${hidden} sensitive ${hidden === 1 ? "breach" : "breaches"} not named publicly)` : "";
    return { entities, links, note: `${entities.length} ${entities.length === 1 ? "breach exposes" : "breaches expose"} this address${hiddenBit}` };
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
  return (await getTransforms()).filter((t) => t.inputTypes.includes(type) && !t.disabled);
}

export async function findTransform(key: string): Promise<TransformDef | undefined> {
  return (await getTransforms()).find((t) => t.key === key);
}

/** Resolve the Wikimedia Geo SQLite index path, or null when not configured.
 * Primary: MERIDIAN_WIKIMEDIA_DB env. Fallback: wikimedia-geo.db next to
 * meridian's own data dir (both live outside git). Never throws. */
export function wikimediaGeoDbPath(): string | null {
  const env = (process.env.MERIDIAN_WIKIMEDIA_DB || "").trim();
  if (env && existsSync(env)) return env;
  const fallback = new URL("../data/wikimedia-geo.db", import.meta.url).pathname;
  if (existsSync(fallback)) return fallback;
  return null;
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
