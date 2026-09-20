// meridian — company enrichment.
// Scrapes a company's OWN public web pages for its profile and principal
// contacts (executives/directors listed on the company's own domain), then
// lets the caller fold in the keyless registry sources (GLEIF / SEC EDGAR /
// Wikidata orgs) for the same company.
//
// BOUNDARIES (user decision): business-entity information only. The scraper
// is whitelisted to the resolved company domain — social-profile hosts,
// search engines, and anything else off-domain is never fetched. Principals
// are only people the company itself publishes on its own pages; emails are
// kept only when they appear on those pages AND belong to the company domain.
// No JS rendering (raw HTML only), polite UA, per-request timeouts, and a
// total time budget — this is primitive scraping, done honestly.

import type { GNode, GEdge } from "./sources";

export const ENRICH_UA = "meridian-osint/1.0 (local recon tool; company enrichment)";

export interface EnrichPrincipal {
  name: string; title: string; email?: string; source_url: string;
}
export interface EnrichCompany {
  name: string; domain: string; description?: string; founded?: string; employees?: string;
}
export interface EnrichResult {
  company: EnrichCompany; principals: EnrichPrincipal[]; notes: string[];
}

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

// Hosts that are never scraped: social profiles, search engines, and other
// off-domain content. The whitelist is the company's own domain (plus its
// subdomains); this blocklist is a second line of defense.
const BLOCKED_HOSTS = new Set([
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "instagram.com",
  "tiktok.com", "youtube.com", "pinterest.com", "reddit.com", "github.com",
  "gitlab.com", "medium.com", "crunchbase.com", "signalhire.com", "zoominfo.com",
  "apollo.io", "lusha.com", "rocketreach.co", "bloomberg.com",
  "google.com", "bing.com", "duckduckgo.com", "yahoo.com",
]);

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function sameSite(host: string, domain: string): boolean {
  const h = host.toLowerCase(), d = domain.toLowerCase();
  return h === d || h.endsWith("." + d);
}

/** True when this URL may be scraped: http(s), on the company domain, and
 *  not a blocked social/search/data-broker host. */
export function isScrapableUrl(url: string, domain: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  for (const b of BLOCKED_HOSTS) {
    if (host === b || host.endsWith("." + b)) return false;
  }
  return sameSite(host, domain);
}

// ---------- robots.txt ----------

/** Parse Disallow path prefixes from a robots.txt body. */
export function parseRobotsDisallow(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s*disallow\s*:\s*(\S+)/i.exec(line.trim());
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

export function pathAllowed(path: string, disallows: string[]): boolean {
  const p = path.split("?")[0].split("#")[0] || "/";
  for (const d of disallows) {
    if (d === "/") return false;
    if (d && p.startsWith(d)) return false;
  }
  return true;
}

// ---------- fetch helpers ----------

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchText(url: string, fetchImpl: FetchFn, timeoutMs: number): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": ENRICH_UA, "Accept": "text/html,application/xhtml+xml" },
    });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct && !ct.includes("html") && !ct.includes("text")) return null;
    const text = await r.text();
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  } catch {
    return null;
  } finally { clearTimeout(t); }
}

// ---------- domain resolution ----------

const DOMAIN_LIKE = /^(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d+)?(?:[\/?#]|$)/i;

/** If the query itself is a domain/URL, return the host. */
export function domainFromQuery(query: string): string | null {
  const m = DOMAIN_LIKE.exec(query.trim());
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (!host.includes(".") || /\s/.test(host)) return null;
  return host;
}

/** Extract candidate result URLs from a DuckDuckGo html-lite response. */
export function parseDdgResults(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/[?&]uddg=([^"&]+)/g)) {
    try {
      const u = decodeURIComponent(m[1]);
      if (/^https?:\/\//i.test(u) && !seen.has(u)) { seen.add(u); out.push(u); }
    } catch { /* bad encoding — skip */ }
  }
  return out.slice(0, 10);
}

function ddgSearchUrl(query: string): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + " official website")}`;
}

/**
 * Resolve a company name (or raw domain) to a verified company domain.
 * Strategy: direct domain in query → DuckDuckGo html-lite → <name>.com guess.
 * Each candidate is verified with a real homepage fetch. Returns null when
 * nothing resolves — the job then fails with a clear note instead of
 * scraping blindly.
 */
export async function resolveDomain(
  query: string, fetchImpl: FetchFn = fetch, timeoutMs = 12000,
): Promise<{ domain: string; homepage: string } | null> {
  const candidates: string[] = [];
  const direct = domainFromQuery(query);
  if (direct) candidates.push(direct);
  if (!direct) {
    const ddg = await fetchText(ddgSearchUrl(query), fetchImpl, timeoutMs);
    if (ddg) {
      for (const u of parseDdgResults(ddg)) {
        const h = hostOf(u);
        if (h && !BLOCKED_HOSTS.has(h) && !candidates.includes(h)) candidates.push(h);
        if (candidates.length >= 4) break;
      }
    }
    // last resort: <slugified-name>.com
    const guess = slug(query.split(/\s+/).slice(0, 3).join(" ")) + ".com";
    if (!candidates.includes(guess)) candidates.push(guess);
  }
  for (const host of candidates) {
    for (const scheme of ["https://", "http://"]) {
      const url = scheme + host + "/";
      const page = await fetchText(url, fetchImpl, timeoutMs);
      if (page !== null) return { domain: host, homepage: url };
    }
  }
  return null;
}

// ---------- profile parsing ----------

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function metaContent(html: string, attr: string, name: string): string | null {
  const re = new RegExp(
    `<meta[^>]*${attr}="${name}"[^>]*content="([^"]{1,400})"`, "i");
  const m = re.exec(html);
  if (m) return stripTags(m[1]);
  const re2 = new RegExp(
    `<meta[^>]*content="([^"]{1,400})"[^>]*${attr}="${name}"`, "i");
  const m2 = re2.exec(html);
  return m2 ? stripTags(m2[1]) : null;
}

const ORG_TYPES = new Set([
  "organization", "corporation", "localbusiness", "professionalservice",
  "store", "restaurant", "medicalbusiness", "legalservice", "financialservice",
]);

interface JsonLdProfile {
  name?: string; description?: string; founded?: string; employees?: string;
  staff: { name: string; title: string }[];
}

/** Pull Organization-ish JSON-LD blocks: profile fields plus employee/member lists. */
export function extractJsonLd(html: string): JsonLdProfile {
  const out: JsonLdProfile = { staff: [] };
  for (const m of html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: any;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const it of items) {
      const graphs = Array.isArray(it?.["@graph"]) ? it["@graph"] : [it];
      for (const g of graphs) {
        if (!g || typeof g !== "object") continue;
        const types = (Array.isArray(g["@type"]) ? g["@type"] : [g["@type"]])
          .map((t: any) => String(t || "").toLowerCase());
        if (!types.some((t: string) => ORG_TYPES.has(t))) continue;
        if (!out.name && g.name) out.name = stripTags(String(g.name)).slice(0, 90);
        if (!out.description && g.description)
          out.description = stripTags(String(g.description)).slice(0, 300);
        const fd = g.foundingDate || g.foundingdate;
        if (!out.founded && fd) out.founded = stripTags(String(fd)).slice(0, 20);
        const ne = g.numberOfEmployees;
        if (!out.employees && ne != null) {
          const v = typeof ne === "object" ? ne.value : ne;
          if (v != null) out.employees = stripTags(String(v)).slice(0, 20);
        }
        for (const key of ["employee", "member", "members"]) {
          const arr = Array.isArray(g[key]) ? g[key] : g[key] ? [g[key]] : [];
          for (const p of arr) {
            if (!p || typeof p !== "object") continue;
            const nm = p.name ? stripTags(String(p.name)) : "";
            const ti = p.jobTitle ? stripTags(String(p.jobTitle)) : "";
            if (nm && ti) out.staff.push({ name: nm.slice(0, 60), title: ti.slice(0, 90) });
          }
        }
      }
    }
  }
  return out;
}

export function extractMetaProfile(html: string): { title?: string; description?: string } {
  const title = metaContent(html, "property", "og:title") ||
    (() => { const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html); return m ? stripTags(m[1]) : null; })();
  const description = metaContent(html, "property", "og:description") ||
    metaContent(html, "name", "description") || undefined;
  return { title: title || undefined, description: description || undefined };
}

// ---------- principal extraction ----------

// Executive-ish titles. Deliberately broad on "director"/"head of" — the
// business-only guarantee comes from *where* we scrape (the company's own
// pages), not from title snobbery.
const TITLE_RE = /\b(ceo|chief executive|chief financial|chief technology|chief operating|chief marketing|chief product|chief revenue|chief information|cfo|cto|coo|cmo|cpo|cro|cio|founder|co-founder|co founder|cofounder|president|chairman|chairwoman|chairperson|managing director|executive director|director|partner|managing partner|vice president|senior vice president|executive vice president|\bvp\b|\bsvp\b|\bevp\b|head of|general manager|principal|owner|board member)\b/i;

const CORP_SUFFIX = new Set([
  "inc", "llc", "ltd", "corp", "corporation", "co", "gmbh", "plc", "sa",
  "sas", "bv", "pty", "holdings", "group", "partners", "ventures", "capital",
  "limited", "incorporated", "company",
]);

const NAME_PART = /^[A-ZÀ-Þ][a-zà-þ.'-]*$|^[A-ZÀ-Þ]\.$/;

/** A plausible executive name: 2–4 capitalized tokens, no corporate suffixes. */
export function validPrincipalName(name: string): boolean {
  const t = name.trim().replace(/\s+/g, " ");
  if (t.length < 3 || t.length > 60) return false;
  if (/\d/.test(t)) return false;
  const parts = t.split(" ");
  if (parts.length < 2 || parts.length > 4) return false;
  for (const p of parts) if (!NAME_PART.test(p)) return false;
  const last = parts[parts.length - 1].toLowerCase().replace(/\.$/, "");
  if (CORP_SUFFIX.has(last)) return false;
  if (TITLE_RE.test(t)) return false; // "Chief Executive" is a title, not a name
  return true;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function withoutScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/**
 * Extract (name, title) principal pairs from raw page HTML. Two strategies:
 *  1. heading pairs — <h2>Name</h2><p>Title</p> style team listings;
 *  2. team cards — containers whose class mentions team/member/leadership,
 *     from which the first name-like and title-like lines are taken.
 * Emails are kept only from mailto: links inside the same card, and only
 * when they belong to the company domain.
 */
export function extractPrincipals(
  html: string, sourceUrl: string, domain: string,
): EnrichPrincipal[] {
  const out: EnrichPrincipal[] = [];
  const seen = new Map<string, number>(); // normalized name -> index in out
  const push = (name: string, title: string, email?: string) => {
    const n = cleanText(name), t = cleanText(title);
    if (!validPrincipalName(n) || !TITLE_RE.test(t)) return;
    const key = n.toLowerCase();
    let pEmail: string | undefined;
    if (email && domain) {
      const ehost = email.split("@")[1]?.toLowerCase() || "";
      if (ehost && sameSite(ehost, domain)) pEmail = email.toLowerCase();
    }
    const existing = seen.get(key);
    if (existing !== undefined) {
      // upgrade: a later sighting with a company-domain email wins
      if (pEmail && !out[existing].email) out[existing].email = pEmail;
      return;
    }
    seen.set(key, out.length);
    const p: EnrichPrincipal = { name: n, title: t.slice(0, 90), source_url: sourceUrl };
    if (pEmail) p.email = pEmail;
    out.push(p);
  };

  const clean = withoutScripts(html);

  // Strategy 1: heading + following title line.
  const pairRe = /<h[1-4][^>]*>\s*([^<>{}]{2,60}?)\s*<\/h[1-4]>\s*(?:<(?:p|div|span|strong|em)[^>]*>\s*)?([^<>{}]{2,90}?)\s*(?:<\/(?:p|div|span|strong|em)>|<br\s*\/?>)/gi;
  for (const m of clean.matchAll(pairRe)) push(m[1], m[2]);

  // Strategy 2: team-ish cards.
  const cardRe = /<(div|li|article|section)[^>]*class="[^"]*(?:team|staff|member|leader|board|people|profile|person|founder)[^"]*"[^>]*>([\s\S]{0,2000}?)<\/\1>/gi;
  for (const m of clean.matchAll(cardRe)) {
    const inner = m[2];
    const lines = inner
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:h[1-4]|p|div|li|span|strong|em)>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .split("\n").map(cleanText).filter((l) => l.length >= 2 && l.length <= 90);
    const nameLine = lines.find((l) => validPrincipalName(l));
    if (!nameLine) continue;
    const titleLine = lines.find((l) => l !== nameLine && TITLE_RE.test(l));
    if (!titleLine) continue;
    let email: string | undefined;
    const mail = /mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(inner);
    if (mail) email = mail[1];
    push(nameLine, titleLine, email);
  }
  return out;
}

// ---------- the scrape ----------

export interface EnrichOptions {
  budgetMs?: number;
  concurrency?: number;
  perRequestMs?: number;
  fetchImpl?: FetchFn;
  progress?: (done: number, total: number, current: string) => void;
}

const TEAM_PATHS = [
  "/", "/about", "/about-us", "/team", "/our-team", "/leadership",
  "/company", "/contact", "/people", "/management",
];

interface PageHit { url: string; html: string }

async function scrapePages(
  domain: string, fetchImpl: FetchFn, opts: Required<Pick<EnrichOptions, "concurrency" | "perRequestMs">> & { deadline: number },
  progress?: EnrichOptions["progress"],
): Promise<{ hits: PageHit[]; profile: { title?: string; description?: string }; jsonld: JsonLdProfile }> {
  let disallows: string[] = [];
  const robots = await fetchText(`https://${domain}/robots.txt`, fetchImpl, 8000);
  if (robots) disallows = parseRobotsDisallow(robots);

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const p of TEAM_PATHS) {
    if (!pathAllowed(p, disallows)) continue;
    const u = `https://${domain}${p}`;
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
  }
  const total = urls.length;
  const hits: PageHit[] = [];
  let profile: { title?: string; description?: string } = {};
  const jsonld: JsonLdProfile = { staff: [] };
  let done = 0;

  const fetchOne = async (url: string): Promise<PageHit | null> => {
    if (Date.now() > opts.deadline) return null;
    progress?.(done, total, url.replace(`https://${domain}`, "") || "/");
    // https first, plain http as a fallback for http-only company sites
    let html = await fetchText(url, fetchImpl, opts.perRequestMs);
    if (html === null && url.startsWith("https://")) {
      html = await fetchText("http://" + url.slice("https://".length), fetchImpl, opts.perRequestMs);
    }
    done++;
    progress?.(done, total, "");
    if (html === null || !isScrapableUrl(url, domain)) return null;
    return { url, html };
  };

  // small worker pool
  const out: (PageHit | null)[] = new Array(urls.length).fill(null);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(opts.concurrency, urls.length) }, async () => {
      while (i < urls.length) { const j = i++; out[j] = await fetchOne(urls[j]); }
    });
  await Promise.all(workers);
  for (const h of out) if (h) hits.push(h);

  // profile: prefer /about-ish pages, fall back to homepage
  const aboutFirst = [...hits].sort((a, b) => {
    const score = (u: string) =>
      /about|company/.test(u) ? 0 : u.endsWith("/") ? 2 : 1;
    return score(a.url) - score(b.url);
  });
  for (const h of aboutFirst) {
    const mp = extractMetaProfile(h.html);
    if (!profile.title && mp.title) profile.title = mp.title;
    if (!profile.description && mp.description) profile.description = mp.description;
    const jl = extractJsonLd(h.html);
    for (const k of ["name", "description", "founded", "employees"] as const)
      if (!jsonld[k] && jl[k]) (jsonld as any)[k] = jl[k];
    jsonld.staff.push(...jl.staff);
    if (profile.title && profile.description && jsonld.name) break;
  }
  return { hits, profile, jsonld };
}

/**
 * Full company-site enrichment: resolve pages, extract profile + principals,
 * and build the graph nodes/edges. Registry fold-in (GLEIF/SEC/Wikidata) is
 * done by the caller in sources.ts so the collectors stay in one place.
 */
export async function enrichCompanySite(
  domain: string, opts: EnrichOptions = {},
): Promise<{ result: EnrichResult; nodes: GNode[]; edges: GEdge[] }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const deadline = Date.now() + (opts.budgetMs ?? 60000);
  const notes: string[] = [];
  const { hits, profile, jsonld } = await scrapePages(
    domain, fetchImpl,
    { concurrency: opts.concurrency ?? 3, perRequestMs: opts.perRequestMs ?? 12000, deadline },
    opts.progress,
  );
  if (!hits.length) {
    notes.push("no pages could be fetched");
  }

  const name = jsonld.name || profile.title || domain;
  const company: EnrichCompany = {
    name: name.slice(0, 90), domain,
    description: jsonld.description || profile.description,
    founded: jsonld.founded, employees: jsonld.employees,
  };

  const principals: EnrichPrincipal[] = [];
  const seen = new Set<string>();
  const addP = (p: EnrichPrincipal) => {
    const k = p.name.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    principals.push(p);
  };
  for (const s of jsonld.staff) {
    if (validPrincipalName(s.name) && TITLE_RE.test(s.title))
      addP({ name: cleanText(s.name), title: cleanText(s.title).slice(0, 90), source_url: hits[0]?.url || `https://${domain}/` });
  }
  for (const h of hits) {
    if (Date.now() > deadline) { notes.push("time budget exhausted — partial results"); break; }
    for (const p of extractPrincipals(h.html, h.url, domain)) addP(p);
    if (principals.length >= 25) break;
  }
  if (!principals.length) notes.push("no principals found on the company's public pages");

  // graph
  const dSlug = slug(domain);
  const companyId = `enrich:company:${dSlug}`;
  const domainId = `urlscan:domain:${dSlug}`; // reused by convention (see sources.ts)
  const nodes: GNode[] = [
    {
      id: domainId, label: domain, type: "infra", subtype: "domain",
      source: "enrich", url: `https://${domain}/`,
    },
    {
      id: companyId, label: company.name, type: "org", subtype: "company",
      source: "enrich",
      detail: [
        company.description,
        company.founded ? `founded ${company.founded}` : "",
        company.employees ? `${company.employees} employees` : "",
      ].filter(Boolean).join(" · ").slice(0, 280),
      url: `https://${domain}/`,
    },
  ];
  const edges: GEdge[] = [{ from: companyId, to: domainId, label: "homepage" }];
  for (const p of principals) {
    const pid = `enrich:person:${slug(p.name)}`;
    nodes.push({
      id: pid, label: p.name, type: "person", subtype: "executive",
      source: "enrich",
      detail: [p.title, p.email].filter(Boolean).join(" · ").slice(0, 200),
      url: p.source_url,
    });
    edges.push({ from: pid, to: companyId, label: p.title.toLowerCase().includes("founder") ? "founder of" : "executive at" });
  }
  return { result: { company, principals, notes }, nodes, edges };
}
