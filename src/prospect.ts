// meridian — territory prospecting.
// Finds companies by geographic location + industry (a salesperson building
// a book of business): Nominatim geocodes the territory, an Overpass query
// pulls businesses matching curated OSM tag selectors (or, for unknown
// industries, a case-insensitive name regex), and the results become company
// nodes in the graph with edges into a territory node.
//
// BOUNDARIES (user decision): business entities only — companies, never
// personal data. One Nominatim query and one Overpass query per run, both
// timeout-guarded, no retries: a miss throws a clear error and the runner
// lands the job in failed/partial instead of hammering the public APIs.

import type { GNode, GEdge } from "./sources";

export const PROSPECT_UA = "meridian-osint/1.0 (local recon tool; territory prospecting)";
// Base URLs are overridable so a smoke test (or a self-hosted Overpass
// mirror) can redirect them without touching the network defaults.
export const PROSPECT_NOMINATIM_BASE =
  process.env.PROSPECT_NOMINATIM_BASE || "https://nominatim.openstreetmap.org";
export const PROSPECT_OVERPASS_URL =
  process.env.PROSPECT_OVERPASS_URL || "https://overpass-api.de/api/interpreter";

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ---------- industry → OSM tag selectors ----------
// Values are "key=value" tag selectors joined by OR in the Overpass query.

export const INDUSTRY_TAGS: Record<string, string[]> = {
  "dentist": ["amenity=dentist"],
  "restaurant": ["amenity=restaurant", "amenity=fast_food"],
  "cafe": ["amenity=cafe"],
  "bar": ["amenity=bar", "amenity=pub"],
  "lawyer": ["office=lawyer"],
  "car repair": ["shop=car_repair"],
  "car dealer": ["shop=car"],
  "fitness": ["leisure=fitness_centre", "leisure=sports_centre"],
  "hotel": ["tourism=hotel", "tourism=hostel", "tourism=guest_house"],
  "pharmacy": ["amenity=pharmacy"],
  "clinic": ["amenity=clinic", "amenity=doctors"],
  "hospital": ["amenity=hospital"],
  "bank": ["amenity=bank"],
  "real estate": ["office=estate_agent"],
  "insurance": ["office=insurance"],
  "accountant": ["office=accountant"],
  "architect": ["office=architect"],
  "hairdresser": ["shop=hairdresser", "shop=beauty"],
  "bakery": ["shop=bakery"],
  "supermarket": ["shop=supermarket", "shop=convenience"],
  "pet": ["shop=pet"],
  "veterinary": ["amenity=veterinary"],
  "plumber": ["craft=plumber"],
  "electrician": ["craft=electrician"],
  "construction": ["office=construction_company"],
  "advertising": ["office=advertising_agency"],
  "it": ["office=it"],
  "coworking": ["office=coworking"],
  "school": ["amenity=school"],
  "university": ["amenity=university", "amenity=college"],
  "museum": ["tourism=museum", "tourism=gallery"],
  "theatre": ["amenity=theatre", "amenity=arts_centre", "amenity=concert_hall", "amenity=cinema"],
  "place of worship": ["amenity=place_of_worship"],
  "fuel": ["amenity=fuel"],
};

// Free-text aliases → canonical industry key (checked after normalization).
const ALIASES: Record<string, string> = {
  "dental": "dentist", "dental clinic": "dentist", "dentistry": "dentist",
  "dentist office": "dentist",
  "law": "lawyer", "law firm": "lawyer", "law office": "lawyer",
  "attorney": "lawyer", "legal": "lawyer",
  "gym": "fitness", "fitness center": "fitness", "fitness centre": "fitness",
  "church": "place of worship", "chapel": "place of worship",
  "mosque": "place of worship", "synagogue": "place of worship", "temple": "place of worship",
  "gas station": "fuel", "gas": "fuel", "petrol": "fuel",
  "salon": "hairdresser", "barber": "hairdresser", "barber shop": "hairdresser", "barbershop": "hairdresser",
  "beauty": "hairdresser", "nail salon": "hairdresser",
  "grocery": "supermarket", "grocery store": "supermarket", "grocer": "supermarket",
  "vet": "veterinary", "veterinarian": "veterinary", "animal hospital": "veterinary",
  "marketing": "advertising", "advertising agency": "advertising", "ad agency": "advertising",
  "software": "it", "tech": "it", "technology": "it", "software company": "it",
  "computer": "it",
  "plumbing": "plumber",
  "electrical": "electrician",
  "mechanic": "car repair", "auto repair": "car repair", "car repair shop": "car repair",
  "auto repair shop": "car repair", "garage": "car repair",
  "auto dealer": "car dealer", "dealership": "car dealer", "car dealership": "car dealer",
  "realtor": "real estate", "real estate agent": "real estate", "estate agent": "real estate",
  "insurance agent": "insurance", "insurance company": "insurance",
  "accounting": "accountant", "cpa": "accountant", "bookkeeping": "accountant",
  "architecture": "architect",
  "eatery": "restaurant", "diner": "restaurant", "pizzeria": "restaurant", "pizza": "restaurant",
  "coffee": "cafe", "coffee shop": "cafe",
  "pub": "bar", "nightclub": "bar", "cocktail bar": "bar",
  "b&b": "hotel", "motel": "hotel", "inn": "hotel",
  "drugstore": "pharmacy", "chemist": "pharmacy",
  "doctor": "clinic", "medical": "clinic", "dental care": "dentist",
  "nursery school": "school", "kindergarten": "school",
  "college": "university",
  "gallery": "museum", "art gallery": "museum",
  "cinema": "theatre", "movie theater": "theatre", "concert hall": "theatre",
  "pet store": "pet", "pet shop": "pet",
  "shared office": "coworking", "co-working": "coworking",
};

/** Cheap plural stripping: "restaurants"→"restaurant", "churches"→"church", "bakeries"→"bakery". */
export function singularish(s: string): string {
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
  if ((s.endsWith("ches") || s.endsWith("shes") || s.endsWith("sses") || s.endsWith("zzes")) && s.length > 5)
    return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) return s.slice(0, -1);
  return s;
}

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Map free industry text to curated OSM tag selectors, or null when the
 * industry isn't covered (caller falls back to a name-regex query).
 * Handles plurals, aliases ("law firms"→lawyer), and trailing phrases
 * ("specialty dental clinics"→dentist via the "dental clinics" tail).
 */
export function matchIndustry(industryText: string): string[] | null {
  const t = normalize(industryText);
  if (!t) return null;
  if (INDUSTRY_TAGS[t]) return INDUSTRY_TAGS[t];
  if (ALIASES[t] && INDUSTRY_TAGS[ALIASES[t]]) return INDUSTRY_TAGS[ALIASES[t]];
  const sg = singularish(t);
  if (sg !== t) {
    if (INDUSTRY_TAGS[sg]) return INDUSTRY_TAGS[sg];
    if (ALIASES[sg] && INDUSTRY_TAGS[ALIASES[sg]]) return INDUSTRY_TAGS[ALIASES[sg]];
  }
  // trailing-phrase scan: "family dental clinic" → "dental clinic"
  const words = t.split(" ");
  for (let i = 1; i < words.length; i++) {
    const tail = singularish(words.slice(i).join(" "));
    if (INDUSTRY_TAGS[tail]) return INDUSTRY_TAGS[tail];
    if (ALIASES[tail] && INDUSTRY_TAGS[ALIASES[tail]]) return INDUSTRY_TAGS[ALIASES[tail]];
  }
  return null;
}

// ---------- Overpass query ----------

export type ProspectSelector =
  | { kind: "tags"; selectors: string[] }
  | { kind: "name"; keyword: string };

export interface BBox { s: number; w: number; n: number; e: number }

/** Escape Overpass regex metacharacters in a fallback keyword. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bounded Overpass QL: 40s server timeout, up to 100 elements with coordinates. */
export function buildOverpassQuery(bbox: BBox, sel: ProspectSelector): string {
  const area = `(${bbox.s},${bbox.w},${bbox.n},${bbox.e})`;
  const stmts: string[] =
    sel.kind === "tags"
      ? sel.selectors.map((s) => {
          const eq = s.indexOf("=");
          const k = s.slice(0, eq), v = s.slice(eq + 1);
          return `nwr["${k}"="${v}"]${area};`;
        })
      : [`nwr["name"~"${escapeRegex(sel.keyword)}",i]${area};`];
  return `[out:json][timeout:40];\n(\n  ${stmts.join("\n  ")}\n);\nout center 100;`;
}

// ---------- geocode ----------

export interface ProspectGeo {
  lat: number; lon: number; bbox: BBox; display_name: string;
}

/**
 * Geocode the territory with Nominatim. ONE query per job, no retries.
 * A miss throws a clear "location not found: ..." error so the runner can
 * land the job in a failed state instead of proceeding blindly.
 */
export async function geocodeLocation(
  location: string, fetchImpl: FetchFn = fetch, timeoutMs = 20000,
): Promise<ProspectGeo> {
  const url =
    `${PROSPECT_NOMINATIM_BASE}/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(location)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": PROSPECT_UA, "Accept-Language": "en" },
    });
    if (!r.ok) throw new Error(`nominatim HTTP ${r.status}`);
    const j: any = await r.json();
    if (!j?.length) throw new Error(`location not found: ${location}`);
    const g = j[0];
    const lat = Number(g.lat), lon = Number(g.lon);
    const dLat = 0.12, dLon = 0.12 / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    return {
      lat, lon,
      bbox: { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon },
      display_name: g.display_name || location,
    };
  } finally { clearTimeout(t); }
}

async function fetchOverpass(
  q: string, fetchImpl: FetchFn, timeoutMs = 60000,
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(PROSPECT_OVERPASS_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": PROSPECT_UA,
      },
      body: "data=" + encodeURIComponent(q),
    });
    if (!r.ok) throw new Error(`overpass HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------- address + parsing ----------

export function formatAddress(tags: Record<string, string>): string {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const line2 = [tags["addr:city"], tags["addr:state"], tags["addr:postcode"]]
    .filter(Boolean).join(" ").trim();
  return [street, line2].filter(Boolean).join(", ");
}

export interface ProspectCompany {
  name: string; address: string; lat: number; lon: number;
  tags: Record<string, string>; industry: string; territory: string;
  source: "overpass"; prospect: true;
}

const MAX_COMPANIES = 100;

function parseElements(
  j: any, industry: string, territoryLabel: string, territoryId: string,
): { companies: ProspectCompany[]; nodes: GNode[]; edges: GEdge[] } {
  const companies: ProspectCompany[] = [];
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  for (const el of j?.elements || []) {
    const tags: Record<string, string> = el.tags || {};
    const name = String(tags.name || "").trim();
    if (!name) continue; // nameless elements aren't prospects
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key || seen.has(key)) continue;
    const lat = typeof el.lat === "number" ? el.lat : el.center?.lat;
    const lon = typeof el.lon === "number" ? el.lon : el.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    if (companies.length >= MAX_COMPANIES) break;
    seen.add(key);
    const address = formatAddress(tags);
    companies.push({
      name, address, lat, lon, tags, industry,
      territory: territoryLabel, source: "overpass", prospect: true,
    });
    const id = `prospect:${slug(name)}-${companies.length - 1}`;
    nodes.push({
      id, label: name, type: "org", subtype: "prospect",
      source: "overpass",
      detail: address ? `${industry} · ${address}` : industry,
      lat, lon,
      url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`,
    });
    edges.push({ from: id, to: territoryId, label: "located in" });
  }
  return { companies, nodes, edges };
}

// ---------- the run ----------

export interface ProspectOptions {
  fetchImpl?: FetchFn;
  timeoutMs?: number;         // nominatim timeout (default 20s)
  overpassTimeoutMs?: number; // default 60s
  progress?: (done: number, total: number, current: string) => void;
  /** Called after geocode (territory node) and after the overpass parse —
   *  lets the runner persist the graph incrementally. */
  onPartial?: (nodes: GNode[], edges: GEdge[]) => void;
}

const TOTAL_STEPS = 3;

/**
 * Prospect a territory: geocode → overpass → company records + graph.
 * Everything is timeout-guarded; the industry-text → tag match is
 * deterministic and offline, so only the two intended public-API calls
 * ever touch the network.
 */
export async function runProspect(
  location: string, industry: string, opts: ProspectOptions = {},
): Promise<{ companies: ProspectCompany[]; nodes: GNode[]; edges: GEdge[] }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const progress = opts.progress || (() => {});
  progress(0, TOTAL_STEPS, "geocoding");
  const geo = await geocodeLocation(location, fetchImpl, opts.timeoutMs ?? 20000);

  const terrLabel = geo.display_name.split(",").slice(0, 2).join(",").trim() || location;
  const territoryId = `prospect:territory:${slug(geo.display_name || location)}`;
  const territory: GNode = {
    id: territoryId, label: terrLabel, type: "place", subtype: "territory",
    source: "overpass",
    detail: `prospecting territory · ${industry}`,
    lat: geo.lat, lon: geo.lon,
    url: `https://www.openstreetmap.org/?mlat=${geo.lat}&mlon=${geo.lon}#map=12/${geo.lat}/${geo.lon}`,
  };
  opts.onPartial?.([territory], []);

  progress(1, TOTAL_STEPS, "querying overpass");
  const selectors = matchIndustry(industry);
  const q = buildOverpassQuery(
    geo.bbox,
    selectors
      ? { kind: "tags", selectors }
      : { kind: "name", keyword: normalize(industry) || industry.trim() },
  );
  const j = await fetchOverpass(q, fetchImpl, opts.overpassTimeoutMs ?? 60000);

  progress(2, TOTAL_STEPS, "building graph");
  const { companies, nodes, edges } = parseElements(j, industry.trim(), terrLabel, territoryId);
  const allNodes = [territory, ...nodes];
  opts.onPartial?.(allNodes, edges);
  progress(3, TOTAL_STEPS, "");
  return { companies, nodes: allNodes, edges };
}
