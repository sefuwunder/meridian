// meridian — OSINT collectors. Every source is free and keyless.
// Each collector returns graph nodes + edges; failures throw and are
// recorded per-source by the runner (best-effort: one dead source never
// kills the recon).

export type NodeType =
  | "city" | "place" | "culture" | "org" | "infra"
  | "person" | "news" | "data" | "note";

export interface GNode {
  id: string; label: string; type: NodeType; subtype?: string;
  source: string; detail?: string; url?: string; lat?: number; lon?: number;
}
export interface GEdge { from: string; to: string; label: string; kind?: string }
export interface SourceResult { nodes: GNode[]; edges: GEdge[]; note?: string }

export interface Ctx {
  city: string;
  lat: number; lon: number;
  bbox: { s: number; w: number; n: number; e: number };
  country: string; countryCode: string;
  cityId: string;
  facts: Record<string, any>;
}

const UA = "meridian-osint/1.0 (local recon tool)";
const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

async function fetchJson(url: string, opts: RequestInit = {}, timeoutMs = 25000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts, signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchText(url: string, opts: RequestInit = {}, timeoutMs = 25000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts, signal: ctrl.signal,
      headers: { "User-Agent": UA, ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

// ---------- 1. geocode (OpenStreetMap Nominatim) ----------

export async function collectGeocode(city: string): Promise<{ geo: any; result: SourceResult }> {
  const j = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(city)}`,
    { headers: { "Accept-Language": "en" } }, 20000);
  if (!j?.length) throw new Error("city not found");
  const g = j[0];
  const lat = Number(g.lat), lon = Number(g.lon);
  const dLat = 0.12, dLon = 0.12 / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const country = g.address?.country || "";
  const countryCode = (g.address?.country_code || "").toUpperCase();
  const cityId = `city:${slug(g.display_name?.split(",")[0] || city)}`;
  const geo = {
    lat, lon, country, countryCode, cityId,
    bbox: { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon },
  };
  const result: SourceResult = {
    nodes: [{
      id: cityId, label: g.display_name?.split(",")[0] || city, type: "city",
      source: "geocode", detail: g.display_name || "", lat, lon,
      url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=12/${lat}/${lon}`,
    }],
    edges: [],
    note: g.display_name || "",
  };
  return { geo, result };
}

// ---------- 2. points of interest (OpenStreetMap Overpass) ----------

type Rule = [RegExp, RegExp, NodeType, string];
const POI_RULES: Rule[] = [
  [/^(amenity)$/, /^(restaurant|cafe|fast_food)$/, "place", "food & drink"],
  [/^(amenity)$/, /^(bar|pub|biergarten|nightclub)$/, "place", "nightlife"],
  [/^(tourism)$/, /^(hotel|hostel|guest_house)$/, "place", "stay"],
  [/^(shop)$/, /^(mall|department_store)$/, "place", "shopping"],
  [/^(tourism|amenity)$/, /^(museum|gallery)$/, "culture", "museum"],
  [/^(amenity)$/, /^(theatre|arts_centre|concert_hall|cinema)$/, "culture", "venue"],
  [/^(tourism|leisure)$/, /^(attraction|park|garden|zoo)$/, "culture", "attraction"],
  [/^(amenity)$/, /^(library)$/, "culture", "library"],
  [/^(office)$/, /^(coworking)$/, "org", "coworking"],
  [/^(amenity)$/, /^(university|college)$/, "org", "education"],
  [/^(office)$/, /^(diplomatic)$/, "org", "embassy"],
  [/^(amenity)$/, /^(hospital|clinic|doctors|pharmacy)$/, "infra", "health"],
  [/^(railway|aeroway)$/, /^(station|halt)$/, "infra", "transport"],
  [/^(aeroway)$/, /^(aerodrome|helipad)$/, "infra", "transport"],
  [/^(amenity)$/, /^(place_of_worship)$/, "infra", "worship"],
];

function classify(tags: Record<string, string>): { type: NodeType; subtype: string } | null {
  for (const [keyRe, valRe, type, subtype] of POI_RULES) {
    for (const [k, v] of Object.entries(tags)) {
      if (keyRe.test(k) && valRe.test(v)) return { type, subtype };
    }
  }
  return null;
}

const OVERPASS_Q = (b: Ctx["bbox"]) => `[out:json][timeout:40];
(
  nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|biergarten|nightclub|theatre|arts_centre|concert_hall|cinema|hospital|clinic|doctors|pharmacy|university|college|library|place_of_worship)$"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"~"^(hotel|hostel|guest_house|museum|gallery|attraction)$"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"~"^(park|garden|zoo)$"](${b.s},${b.w},${b.n},${b.e});
  nwr["office"~"^(coworking|diplomatic)$"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"~"^(mall|department_store)$"](${b.s},${b.w},${b.n},${b.e});
  nwr["railway"~"^(station|halt)$"](${b.s},${b.w},${b.n},${b.e});
  nwr["aeroway"~"^(aerodrome|helipad)$"](${b.s},${b.w},${b.n},${b.e});
);
out center 600;`;

export async function collectOverpass(ctx: Ctx): Promise<SourceResult> {
  const q = OVERPASS_Q(ctx.bbox);
  const payload = "data=" + encodeURIComponent(q);
  let j: any = null, lastErr: any = null;
  for (const host of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
    try {
      j = await fetchJson(host, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload,
      }, 60000);
      break;
    } catch (e) { lastErr = e; }
  }
  if (!j) throw lastErr || new Error("overpass unreachable");
  const nodes: GNode[] = [], edges: GEdge[] = [];
  const perSubtype: Record<string, number> = {};
  const seen = new Set<string>();
  for (const el of j.elements || []) {
    const tags = el.tags || {};
    const name = (tags.name || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    const cls = classify(tags);
    if (!cls) continue;
    if ((perSubtype[cls.subtype] || 0) >= 14) continue;
    perSubtype[cls.subtype] = (perSubtype[cls.subtype] || 0) + 1;
    seen.add(name.toLowerCase());
    const id = `osm:${slug(name)}`;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    const detailBits = [cls.subtype];
    if (tags.cuisine) detailBits.push(String(tags.cuisine).replace(/;/g, ", "));
    if (tags["addr:street"]) detailBits.push(`${tags["addr:street"]}${tags["addr:housenumber"] ? " " + tags["addr:housenumber"] : ""}`);
    nodes.push({
      id, label: name, type: cls.type, subtype: cls.subtype, source: "overpass",
      detail: detailBits.join(" · "), lat, lon,
      url: lat ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}` : undefined,
    });
    edges.push({ from: id, to: ctx.cityId, label: "in" });
  }
  return { nodes, edges, note: `${nodes.length} POIs across ${Object.keys(perSubtype).length} categories` };
}

// ---------- 3. wikipedia city profile ----------

export async function collectWikipedia(ctx: Ctx): Promise<SourceResult> {
  const title = encodeURIComponent(ctx.city.replace(/ /g, "_"));
  let s: any = null;
  try { s = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`); }
  catch { throw new Error("no wikipedia article"); }
  if (s.type === "disambiguation") throw new Error("wikipedia disambiguation — refine the city name");
  // enrich the city node in place (server merges by id)
  return {
    nodes: [{
      id: ctx.cityId, label: s.title || ctx.city, type: "city", source: "wikipedia",
      detail: s.extract || "", url: s.content_urls?.desktop?.page,
    }],
    edges: [],
    note: s.description || "city profile",
  };
}

// ---------- 4+5. wikidata: companies + notable people ----------

async function resolveQid(city: string): Promise<string> {
  const j = await fetchJson(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(city)}&language=en&format=json&limit=6&origin=*`);
  const cands = (j.search || []).filter((c: any) =>
    /city|capital|municipality|town|metropolis/i.test(c.description || "") || (c.label || "").toLowerCase() === city.toLowerCase());
  const pick = cands[0] || j.search?.[0];
  if (!pick) throw new Error("city not resolved on wikidata");
  return pick.id;
}

async function sparql(query: string): Promise<any[]> {
  const j = await fetchJson(
    `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`,
    { headers: { Accept: "application/sparql-results+json" } }, 30000);
  return j.results?.bindings || [];
}

export async function collectBusiness(ctx: Ctx): Promise<SourceResult> {
  const qid = await resolveQid(ctx.city);
  const rows = await sparql(`SELECT DISTINCT ?c ?cLabel WHERE {
    ?c wdt:P159/wdt:P131* wd:${qid} .
    ?c wdt:P31/wdt:P279* wd:Q4830453 .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 15`);
  const nodes: GNode[] = rows
    .map((r: any) => r.cLabel?.value)
    .filter(Boolean)
    .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
    .slice(0, 15)
    .map((name: string) => ({
      id: `wd:org:${slug(name)}`, label: name, type: "org" as NodeType, subtype: "company",
      source: "wikidata", detail: "headquartered here",
    }));
  return {
    nodes,
    edges: nodes.map((n) => ({ from: n.id, to: ctx.cityId, label: "headquartered in" })),
    note: `${nodes.length} companies`,
  };
}

export async function collectPeople(ctx: Ctx): Promise<SourceResult> {
  const qid = await resolveQid(ctx.city);
  const rows = await sparql(`SELECT DISTINCT ?p ?pLabel WHERE {
    ?p wdt:P19/wdt:P131* wd:${qid} .
    ?p wdt:P31 wd:Q5 .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 15`);
  const nodes: GNode[] = rows
    .map((r: any) => r.pLabel?.value)
    .filter(Boolean)
    .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
    .slice(0, 15)
    .map((name: string) => ({
      id: `wd:person:${slug(name)}`, label: name, type: "person" as NodeType,
      source: "wikidata", detail: "born here",
    }));
  return {
    nodes,
    edges: nodes.map((n) => ({ from: n.id, to: ctx.cityId, label: "born in" })),
    note: `${nodes.length} notable people`,
  };
}

// ---------- 6. music scene (MusicBrainz) ----------

export async function collectMusic(ctx: Ctx): Promise<SourceResult> {
  const j = await fetchJson(
    `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`area:"${ctx.city}"`)}&fmt=json&limit=15`,
    { headers: { Accept: "application/json" } }, 20000);
  const artists = (j.artists || []).filter((a: any) => a.name && a.type !== "Other");
  const nodes: GNode[] = artists.slice(0, 12).map((a: any) => ({
    id: `mb:${slug(a.name)}`, label: a.name, type: "culture" as NodeType, subtype: "music",
    source: "musicbrainz",
    detail: [a["type"], a.country ? `(${a.country})` : "", a.disambiguation].filter(Boolean).join(" "),
    url: `https://musicbrainz.org/artist/${a.id}`,
  }));
  return {
    nodes,
    edges: nodes.map((n) => ({ from: n.id, to: ctx.cityId, label: "from" })),
    note: `${nodes.length} artists`,
  };
}

// ---------- 7. news (Google News RSS) ----------

export async function collectNews(ctx: Ctx): Promise<SourceResult> {
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${encodeURIComponent(ctx.city)}&hl=en-US&gl=US&ceid=US:en`, {}, 20000);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12);
  const nodes: GNode[] = [];
  for (const [, item] of items) {
    const title = (/\<title\>([\s\S]*?)\<\/title\>/.exec(item)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const link = (/\<link\>([\s\S]*?)\<\/link\>/.exec(item)?.[1] || "").trim();
    const pub = (/\<pubDate\>([\s\S]*?)\<\/pubDate\>/.exec(item)?.[1] || "").trim();
    const srcName = (/\<source[^>]*\>([\s\S]*?)\<\/source\>/.exec(item)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    if (!title) continue;
    const clean = title.replace(/\s*-\s*[^-]+$/, ""); // strip trailing " - Source"
    nodes.push({
      id: `news:${slug(clean)}`, label: clean.slice(0, 90), type: "news" as NodeType,
      source: "news", detail: [srcName, pub].filter(Boolean).join(" · "), url: link || undefined,
    });
  }
  return {
    nodes,
    edges: nodes.map((n) => ({ from: n.id, to: ctx.cityId, label: "about" })),
    note: `${nodes.length} headlines`,
  };
}

// ---------- 8. country dossier (REST Countries) ----------

export async function collectCountry(ctx: Ctx): Promise<SourceResult> {
  if (!ctx.countryCode) throw new Error("no country code from geocode");
  const j = await fetchJson(`https://restcountries.com/v3.1/alpha/${ctx.countryCode}`, {}, 20000);
  const c = j[0] || j;
  const curCode = Object.keys(c.currencies || {})[0] || "";
  const curName = c.currencies?.[curCode]?.name || "";
  const langs = Object.values(c.languages || {}).join(", ");
  const calling = (c.idd?.root || "") + (c.idd?.suffixes?.[0] || "");
  const tz = (c.timezones || [])[0] || "";
  const drive = c.car?.side ? `drives on the ${c.car.side}` : "";
  ctx.facts.country = c.name?.common || ctx.country;
  ctx.facts.currency = curCode ? `${curCode} — ${curName}` : "";
  ctx.facts.currencyCode = curCode;
  ctx.facts.languages = langs;
  ctx.facts.callingCode = calling;
  ctx.facts.timezone = tz;
  ctx.facts.region = [c.subregion || c.region].filter(Boolean).join(", ");
  const nodes: GNode[] = [];
  if (curCode) nodes.push({ id: `data:currency`, label: curCode, type: "data", subtype: "currency", source: "restcountries", detail: curName });
  if (langs) nodes.push({ id: `data:languages`, label: "Languages", type: "data", subtype: "language", source: "restcountries", detail: langs });
  if (calling) nodes.push({ id: `data:calling`, label: calling, type: "data", subtype: "calling code", source: "restcountries", detail: "international dial code" });
  if (drive) nodes.push({ id: `data:driving`, label: drive, type: "data", subtype: "driving", source: "restcountries", detail: "" });
  return {
    nodes,
    edges: nodes.map((n) => ({ from: n.id, to: ctx.cityId, label: "fact" })),
    note: c.name?.common || ctx.country,
  };
}

// ---------- 9. money + local time ----------

export async function collectMoneyTime(ctx: Ctx): Promise<SourceResult> {
  const nodes: GNode[] = [], edges: GEdge[] = [];
  const cur = ctx.facts.currencyCode;
  if (cur && cur !== "USD") {
    try {
      const j = await fetchJson(`https://open.er-api.com/v6/latest/${cur}`, {}, 20000);
      const usd = j.rates?.USD;
      if (usd) {
        ctx.facts.usdRate = `1 ${cur} ≈ ${usd} USD`;
        nodes.push({ id: "data:fx", label: `1 ${cur} ≈ ${usd} USD`, type: "data", subtype: "exchange", source: "er-api", detail: `base ${cur}` });
        edges.push({ from: "data:fx", to: ctx.cityId, label: "fact" });
      }
    } catch { /* best effort */ }
  }
  if (ctx.facts.timezone) {
    try {
      const j = await fetchJson(`http://worldtimeapi.org/api/timezone/${encodeURIComponent(ctx.facts.timezone)}`, {}, 20000);
      if (j.datetime) {
        ctx.facts.localTime = j.datetime.slice(11, 16);
        ctx.facts.localDate = j.datetime.slice(0, 10);
        nodes.push({ id: "data:time", label: `Local ${ctx.facts.localTime}`, type: "data", subtype: "time", source: "worldtimeapi", detail: ctx.facts.timezone });
        edges.push({ from: "data:time", to: ctx.cityId, label: "fact" });
      }
    } catch { /* best effort */ }
  }
  return { nodes, edges, note: [ctx.facts.usdRate, ctx.facts.localTime && `local ${ctx.facts.localTime}`].filter(Boolean).join(" · ") || "—" };
}

// ---------- 10. weather (Open-Meteo) ----------

const WMO: Record<number, string> = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
  80: "Light showers", 81: "Showers", 82: "Violent showers", 95: "Thunderstorm",
};

export async function collectWeather(ctx: Ctx): Promise<SourceResult> {
  const j = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${ctx.lat}&longitude=${ctx.lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`, {}, 20000);
  const c = j.current || {};
  const cond = WMO[c.weather_code] || "—";
  ctx.facts.temp = `${Math.round(c.temperature_2m)}°C`;
  ctx.facts.condition = cond;
  return {
    nodes: [{
      id: "data:weather", label: `${Math.round(c.temperature_2m)}°C · ${cond}`, type: "data",
      subtype: "weather", source: "open-meteo",
      detail: [`humidity ${c.relative_humidity_2m}%`, `wind ${c.wind_speed_10m} km/h`].join(" · "),
    }],
    edges: [{ from: "data:weather", to: ctx.cityId, label: "fact" }],
    note: `${Math.round(c.temperature_2m)}°C ${cond}`,
  };
}

export const SOURCE_DEFS = [
  { key: "geocode", label: "Geocode · OpenStreetMap" },
  { key: "overpass", label: "Places · OpenStreetMap" },
  { key: "wikipedia", label: "Profile · Wikipedia" },
  { key: "business", label: "Companies · Wikidata" },
  { key: "people", label: "People · Wikidata" },
  { key: "music", label: "Music scene · MusicBrainz" },
  { key: "news", label: "Headlines · Google News" },
  { key: "country", label: "Country dossier · REST Countries" },
  { key: "moneytime", label: "Money & time · ER API" },
  { key: "weather", label: "Weather · Open-Meteo" },
];

// ---------- keyword interlinking ----------
// Any two non-city nodes sharing a keyword get an edge labeled with the
// shared keyword(s). City/country name tokens are excluded (they'd link
// everything), stopwords in four languages are dropped, and keywords
// appearing on more than maxNodesPerKeyword nodes are treated as noise.
// Re-running strips old keyword edges first, so labels stay current and
// re-runs never duplicate.

const STOPWORDS = new Set(
  ("the and for with from that this these those are was were has have had will would " +
   "can its our your their about into over after before between through during under " +
   "above among within without also just than then when where which while what been " +
   "being does each more most other some such only same very should now new old " +
   "les des une dans sur plus est sont avec pour " +
   "los las del con una uno " +
   "dos das uma com por " +
   "saint sainte").split(" ")
);

export function extractKeywords(text: string): string[] {
  const stem = (w: string) =>
    w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
  const words = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w))
    .map(stem);
  return [...new Set(words)];
}

export function addKeywordEdges(
  nodes: GNode[], edges: GEdge[],
  opts: { excludeTokens?: string[]; maxNodesPerKeyword?: number } = {}
): GEdge[] {
  const exclude = new Set((opts.excludeTokens || []).map((t) => t.toLowerCase()));
  const maxPer = opts.maxNodesPerKeyword ?? 15;
  const index = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.type === "city") continue;
    const text = [n.label, n.subtype, (n.detail || "").slice(0, 300)].filter(Boolean).join(" ");
    for (const kw of extractKeywords(text)) {
      if (exclude.has(kw)) continue;
      if (!index.has(kw)) index.set(kw, []);
      index.get(kw)!.push(n.id);
    }
  }
  const pairKw = new Map<string, Set<string>>();
  for (const [kw, ids] of index) {
    if (ids.length < 2 || ids.length > maxPer) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] < ids[j] ? ids[i] : ids[j];
        const b = ids[i] < ids[j] ? ids[j] : ids[i];
        const pk = a + ">" + b;
        if (!pairKw.has(pk)) pairKw.set(pk, new Set());
        pairKw.get(pk)!.add(kw);
      }
    }
  }
  const kept = edges.filter((e) => e.kind !== "keyword");
  const out = [...kept];
  for (const [pk, kws] of pairKw) {
    const [a, b] = pk.split(">");
    out.push({ from: a, to: b, label: [...kws].slice(0, 3).join(", "), kind: "keyword" });
  }
  return out;
}

// Merge a collector result into the running graph: nodes dedupe by id
// (later collectors enrich earlier fields), edges dedupe by endpoints+label
// and are only kept when both endpoints exist.
export function mergeGraph(
  cur: { nodes: GNode[]; edges: GEdge[] }, add: SourceResult
): { nodes: GNode[]; edges: GEdge[] } {
  const byId = new Map(cur.nodes.map((n) => [n.id, n]));
  for (const n of add.nodes) {
    const ex = byId.get(n.id);
    if (!ex) { byId.set(n.id, { ...n }); continue; }
    for (const [k, v] of Object.entries(n)) {
      if (v !== undefined && v !== "" && (ex as any)[k] === "") (ex as any)[k] = v;
    }
    if (n.detail && ex.detail !== n.detail && !ex.detail?.includes(n.detail.slice(0, 40)))
      ex.detail = [ex.detail, n.detail].filter(Boolean).join(" — ");
    if (n.url && !ex.url) ex.url = n.url;
  }
  const ekey = (e: GEdge) => `${e.from}>${e.to}:${e.label}`;
  const seen = new Set(cur.edges.map(ekey));
  const edges = [...cur.edges];
  for (const e of add.edges) {
    const k = ekey(e);
    if (!seen.has(k) && byId.has(e.from) && byId.has(e.to)) { seen.add(k); edges.push(e); }
  }
  return { nodes: [...byId.values()], edges };
}
