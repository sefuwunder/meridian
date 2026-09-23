# meridian — graph OSINT recon

Land in a foreign city, launch a recon sprint, and watch social, cultural, and
business intel assemble itself into an interactive web of connected nodes.

`meridian` collects from **thirty-eight free, keyless sources** plus five optional
keyed ones (OCCRP Aleph, WiGLE, Exa and Parallel need API credentials to activate;
OpenFEC works out of the box on a low demo quota and accepts a free personal
key for the full rate). It lays the results out as a force-directed node graph: the city
sits pinned at the hub, everything else — restaurants, museums, coworking
spaces, embassies, hospitals, companies, legal entities, notable people,
researchers, artists, headlines, live aircraft, currency, weather, local
time — orbits it, connected by labeled edges.

## Run it

```bash
bun install   # nothing to install — zero dependencies
bun src/server.ts
# → http://localhost:3005
```

Optional keys (never committed). Resolution order: **env var wins**, then the
key saved on the **Keys screen** (top bar), then none. Keys entered in the
browser are stored in `data/keys.json` (gitignored, mode 0600) and take
effect immediately — no restart needed. The Keys screen shows masked status
only (last 4 chars) and has a per-key live test.

```bash
OCCRP_API_KEY=...    # free account at data.occrp.org — activates the OCCRP Aleph collector
OPENFEC_API_KEY=...  # free personal key at api.open.fec.gov — raises OpenFEC from 30/hr to 1,000/hr
EXA_API_KEY=...               # free key at dashboard.exa.ai — activates the Exa web-search source
PARALLEL_API_KEY=...               # free key at dashboard.exa.ai — activates the Exa web-search source
```

Type a city, tick the sources you want, hit **launch recon**. Collection runs in
the background; the graph fills in live as each source lands. A sprint clock in
the header tracks elapsed time.

## Sources

| # | Source | What it contributes |
|---|--------|---------------------|
| 1 | OpenStreetMap Nominatim | geocode, city hub node |
| 2 | OpenStreetMap Overpass | POIs: food & drink, nightlife, stays, museums, venues, coworking, embassies, health, transport, worship, shopping (capped per category) |
| 3 | Wikipedia | city profile, merged onto the hub node |
| 4 | Wikidata SPARQL | companies headquartered in the city |
| 5 | Wikidata SPARQL | notable people born there |
| 6 | MusicBrainz | artists from the city |
| 7 | Google News RSS | latest headlines about the city |
| 8 | REST Countries | currency, languages, dial code, driving side, region |
| 9 | ER API + WorldTimeAPI | USD exchange rate, local time |
| 10 | Open-Meteo | current weather |
| 11 | GDELT 2.0 DOC API | near-real-time news/events mentioning the city (title, outlet, seen-date) |
| 12 | GLEIF LEI (CC0) | legal entities registered in the city + direct/ultimate parent links |
| 13 | OpenSky Network | live aircraft over the city (callsign, altitude, speed, heading) |
| 14 | OpenAlex (CC0) | research institutions + notable affiliated authors |
| 15 | GDACS | disaster alerts (earthquake, cyclone, flood, volcano, drought, wildfire) from the last 90 days, filtered to events in the recon's country or within ~250 km of the city; nodes carry alert level, event type, date, and report link. Keyless, free with attribution. |
| 16 | Library of Congress Chronicling America | historic US newspaper pages (1770–1963) mentioning the city: newspaper title, place of publication, date, link to the LOC page. Keyless, US public domain. One query per recon (~10 req/min guideline); non-US cities skip cleanly. |
| 17 | ICIJ Offshore Leaks | keyless reconciliation API: entities, officers, and intermediaries matching the city across all five leak namespaces (Panama/Paradise/Pandora/Bahamas/Offshore), with match scores and node links. |
| 18 | OCCRP Aleph | entity search across 300+ investigative datasets (company registries, procurement, sanctions, leaks) on the Follow-the-Money model. Keyed-free: stays idle with a setup hint (pointing at the Keys screen) until a key is configured; never blocks the sprint. |
| 19 | urlscan.io | keyless search API: recent public web scans whose page URL mentions the city, expanded into domain → IP → ASN infra nodes with scan links and malicious-verdict flags. One request per recon (~30/min anonymous quota); HTTP 429 ends the source for the run, never retried. |
| 20 | ProPublica Nonprofit Explorer v2 | keyless: IRS nonprofits actually based in the recon city (filtered on the org's city field), with NTEE category and 501(c) subsection. One request per recon. |
| 21 | OpenFEC | keyed-free: campaign committees in the recon's US state plus itemized donors → person→committee "donated to" edges. Works on the built-in demo key at 30 req/hr; `OPENFEC_API_KEY` (env or Keys screen) raises the limit. Two requests per recon. |
| 22 | IPQuery | keyless: geo/ASN/risk enrichment of the IPs urlscan discovered, folded into the existing IP nodes by matching ids. One request per IP, max 8 per recon. |
| 23 | FDIC BankFind | keyless (as of 2026-09-16; FDIC has announced a future Data.gov key requirement): US banks in the recon city by CITY+STALP filter, with assets and FDIC cert. US-only. |
| 24 | Arquivo.pt | keyless: Portuguese web-archive full-text search mentioning the city → archived page nodes. |
| 25 | WiGLE | keyed-free: wireless networks in the recon bbox (SSID, encryption, location). Idles with a setup hint until a key is configured. |
| 26 | Shodan InternetDB | keyless: port/hostname/vuln enrichment of urlscan-discovered IPs, folded into existing IP nodes. |
| 27 | adsb.lol | keyless: live aircraft within 25 nm of the city (callsign, altitude, squawk). |
| 28 | NASA EONET | keyless: natural events (wildfires, storms, volcanoes) in the recon bbox. |
| 29 | USGS FDSN | keyless: earthquakes M2+ within 200 km of the city. |
| 30 | HackerTarget | keyless plain-text API: reverse-IP hostnames, host search, and DNS records for urlscan-discovered IPs/domains. Hard cap of 8 requests per recon (free tier ~100 req/day). |
| 31 | mnemonic PassiveDNS v3 | keyless: passive DNS answers (A/AAAA/CNAME) for up to 3 urlscan-discovered domains, top 15 by observation count. |
| 32 | Cert Spotter | keyless cert-transparency: DNS names from certificate issuances for up to 3 domains (max 40 per domain) → subdomain nodes. |
| 33 | brasilapi | keyless: Brazilian national holidays for BR recon; opportunistic CNPJ enrichment (only numbers with valid check digits found in recon facts) → org + partner nodes. Idles for non-Brazilian cities. |
| 34 | GLEIF name search | keyless: GLEIF `filter[entity.legalName]` for company-name keywords derived from the recon's stashed domains → org nodes (legal name, LEI, status, address) linked to the city hub and back to the matching domain node. 3 keywords × 1 request. Idles when no domains were stashed. |
| 35 | SEC EDGAR | keyless (descriptive User-Agent, well under SEC rate guidance): EFTS full-text search-index for the company keyword → filer CIKs → `data.sec.gov` submissions JSON → org nodes (legal name, CIK, ticker, SIC, business address). 2 keywords × (1 + up to 3) requests. Idles when no domains were stashed. |
| 36 | Wikidata org search | keyless: `wbsearchentities` for the company keyword, then one batched `wbgetentities` call; only items whose direct P31 is a known org class (company, business, public company, enterprise, corporation, technology company) become org nodes. No SPARQL — the transitive path query 502s/times out on the public endpoint. 3 keywords × 2 requests. Idles when no domains were stashed. |
| 37 | HK Companies Registry | keyless (data.cr.gov.hk, refreshed daily): prefix-only company-name search for keywords derived from the recon's stashed domains → org nodes (BRN, registered office address, company type, incorporation date) linked to the city hub and back to the matching domain node. Live local companies only — no officers, filings, or dissolved entities. 3 keywords × 1 request. Idles when no domains were stashed. |
| 38 | Enhetsregisteret | keyless (data.brreg.no, NLOD 2.0): entities registered in the recon city via native municipality scoping — the city maps to a 4-digit kommunenummer through a built-in table of the largest kommuner. One request per recon (≤25 org nodes with org.nr, legal form, business address, activity, konkurs/avvikling flags). Norway-only; idles elsewhere and for cities outside the table. |
| 39 | Exa | keyed-free: keyword web search (`type:"keyword"`, snippet text) for company-name keywords derived from the recon's stashed domains → web-result nodes (title, snippet, URL) linked to the city hub and back to the matching domain node. Mixed general-web payloads (news, people, companies, blogs), so excluded from business-only runs. Capped at 3 keywords × 5 results per run (~1,000 searches/month free tier). Idles with a setup hint until `EXA_API_KEY` is configured, and when no domains were stashed. |
| 40 | Parallel | keyed: natural-language web search with LLM-optimized excerpts for company-name keywords derived from the recon's stashed domains → web-result nodes (title, joined excerpts, publish date, URL) linked to the city hub and back to the matching domain node. Mixed general-web payloads (news, people, companies, blogs), so excluded from business-only runs. Capped at 3 keywords × 5 results per run (mode basic, 6000 excerpt chars per call). Idles with a setup hint until `PARALLEL_API_KEY` is configured, and when no domains were stashed. |
| 41 | Parallel FindAll | keyed: `POST api.parallel.ai/v1beta/findall/entity-search` (`x-api-key` auth) with a city-anchored objective and `entity_type: "companies"` → structured company entities {name, url, description} as org/company nodes wired to the city hub. Companies only, so included in business-only runs. match_limit 25. Same `PARALLEL_API_KEY` as source 40; idles with a setup hint until it is configured. |

Every source is best-effort and independent: one dead API marks its row failed
in the collection panel and the sprint continues. Nothing is ever half-merged —
nodes dedupe by id, edges dedupe by endpoints + label, and edges pointing at
missing nodes are dropped.

Each source is classified in `src/sources.ts` (`SOURCE_DEFS[].business`) for
business-only runs: business data (companies, legal entities, organizations,
filings, registries, business places) vs everything else. `geocode` is plumbing
(city → coordinates, searches nothing) and always runs in both modes.

## Keyword interlinking

Beyond the hub spokes, any two nodes sharing a keyword are connected by a
dashed edge labeled with the shared word(s) — the music venues cluster, the
embassies find each other, a headline links to the company it mentions.
Keywords come from labels, subtypes, and descriptions; city/country names are
excluded (they'd link everything), stopwords in English/French/Spanish/
Portuguese are dropped, and a keyword appearing on more than 15 nodes is
treated as noise. Recomputed from scratch after every source and every analyst
note, so links never duplicate and labels stay current.

## Directed deep search

Click any node and hit **deep search**: the node's label, subtype, and
description are run through the same keyword extractor as the interlinking
above (top 6 keywords after stopword / city-exclusion / noise filtering),
and each keyword is searched against three keyless backends:

- **GDELT 2.0 DOC API** — recent news/events mentioning the keyword (≤8 per keyword)
- **Wikipedia search API** — matching articles, typed person/org/place from their description (≤8)
- **Wikidata entity search** — matching entities with descriptions (≤8)

New nodes reuse the existing `news`/`org`/`person`/`place` types, so the
filters, detail panel, and keyword interlinking pick them up with no graph
changes. Each new node gets an edge back to the original node labeled
`deep search: <keyword>`. Dedupe is strict: a node whose id or URL already
exists in the recon is never added, so re-running a deep search only adds
genuinely new material. The searched node is flagged (the button then reads
"deep search again"). Backends are isolated — if one fails or returns junk,
the others still deliver.

## Rendering performance

The draw loop is built for hundreds of nodes: it never uses alpha blending,
`shadowBlur`, or per-frame gradients — every translucent paint color is
pre-blended once against the background into solid hex, node outlines are
pre-darkened per type, and the dash pattern is one shared array. Per frame:

- edges are drawn in **three batched passes** (solid, dashed keyword, hot)
  — one `strokeStyle` and one `stroke()` each, dash list toggled twice
- node fills + outlines are **batched by type** — one fill + one stroke per
  color instead of per node
- selected / hovered / city nodes get **solid highlight rings** instead of
  shadow-blur glows; search matches keep their light ring
- **one layout read per frame** (the canvas rect is cached; previously every
  node and edge edge re-measured it)
- labels are culled at overview zoom (city, selected, hovered, hubs with
  r ≥ 10.5, search matches) and **truncated to 24 chars** + "…" on canvas
- the physics loop sleeps once the layout settles (zero idle CPU) and drops
  to every other physics tick when a tick exceeds ~24ms

The CSS follows the same rule: no `backdrop-filter` anywhere (panels use
near-opaque solid colors), and the aurora background blobs are static — the
drift animation is gone, so the compositor rasterises them once instead of
repainting three huge blurred layers every frame.

Measured on a synthetic 200-node graph (recording stub canvas, per frame):

| expensive op | before | after |
|---|---|---|
| `getBoundingClientRect` (layout reads) | ~660 | 1 |
| `shadowBlur` assignments | ~200 | 0 |
| `setLineDash` calls | ~40 | 2 |
| `fillStyle` assignments | ~136 | ~12 |
| `strokeStyle` assignments | ~289 | ~11 |
| `globalAlpha` assignments | 0 | 0 |
| gradient creations | 0 | 0 |

Node titles in the detail panel, neighbor list, and recon list are truncated
with ellipsis; the full text is on the `title` tooltip.

## Graph interaction

- **Pan / zoom / drag** — drag the background to pan, scroll to zoom, drag any
  node to reposition it (the layout reheats around your move).
- **Built for scale** — repulsion runs on a spatial hash (not O(n²)), new
  nodes land on a golden-angle spiral so thousands don't start in one dense
  disc, the render loop sleeps when the layout settles (zero idle CPU), and
  physics automatically drops to every other frame if a tick ever exceeds
  ~24ms — pan/zoom stay fluid while the layout catches up. Node size encodes
  connectivity: orphans render at 5px, hubs grow to 16px, the city stays
  dominant at 20px, and well-connected hubs earn labels at overview zoom
  (zoom in to name everything).
- **Click a node** — detail panel with type, source, description, outbound link,
  coordinates, and its connections (click through them).
- **Type chips** — toggle whole categories (places, culture, orgs, people…).
- **Search** — live highlight + jump-to.
- **+ note** — pin an analyst note node onto the graph, linked to the selected
  node (or the city). Your own intel, in the web.
- **Deep search** — one click on any node pulls its keywords through GDELT,
  Wikipedia, and Wikidata and grafts the new nodes onto the graph with
  edges back to the node you searched from.
- **City dossier** — local time, weather, currency + USD rate, languages, dial
  code, region, and the Wikipedia profile, all in the right rail.
- **Export** — full recon as JSON, nodes as CSV.

## Graph analysis tools

Four tools for working a case — available from the top bar and the selection
toolbar:

- **Case files** — named snapshots of the working graph: city metadata, dossier
  facts, source states, nodes, edges, analyst notes, and groups. Stored in
  `data/cases/` (gitignored, files written with mode `0600`). Save the current
  view under a name, open a case to load it, delete old ones, or **merge** a
  saved case into whatever you're looking at. Manual-save by design: merges,
  groups, and edits mark the view dirty (`●` in the title) until you save.
- **Merge nodes** — shift-click (or shift-drag) to multi-select, then *merge*.
  The most informative node survives (label + detail + URL + subtype richness);
  the others are absorbed. Details concatenate with `[label · source]`
  attribution, contributor IDs and sources are preserved, edges are unioned and
  deduplicated, merge-created self-edges are removed, and keyword links are
  recomputed afterward. The city hub can't be merged.
- **Groups** — named, one-level collections: shift-click nodes, *group*, name
  it. Expanded groups draw as a labeled container behind their members;
  collapse one and it becomes a single bubble (members hidden, hit-testable).
  Rename, expand/collapse, select-members, or ungroup (members stay in the
  graph) from the right rail or the detail panel.
- **Merge graphs** — merge a saved case into the current graph. Nodes dedupe
  by id; the conflict rule is existing-wins — the current graph's fields win,
  the incoming case only fills blanks, and differing details concatenate.
  Edges dedupe by endpoints + label, dangling edges are dropped, and new nodes
  land on the golden-angle spiral. Analyst notes are ordinary nodes, so they're
  retained by both merge paths.

## API

```
POST /api/recon            { city, sources? } → { id }          # launch (background)
GET  /api/recon                                            # list recons
GET  /api/recon/:id                                        # full graph + source states + progress
DEL  /api/recon/:id
POST /api/runs             { city, sources?, label?, callback_url?, callback_headers? } → 202 { run_id, status }
GET  /api/runs                                             # newest-first run list
GET  /api/runs/:id                                         # run status, progress, per-source states, result
POST /api/recon/:id/notes  { label, body, link_to? } → { node }
POST /api/recon/:id/deep-search { nodeId } → { addedNodes, addedEdges, keywords }
GET  /api/recon/:id/export                                 # JSON download
GET  /api/keys                                             # key defs + masked status (never full keys)
POST /api/keys { key, value } → { keys }                   # save a key
DEL  /api/keys/:id                                         # clear the stored key
POST /api/keys/test { key } → { ok, detail | error }       # probe the live API
GET  /api/cases                                            # list case files
POST /api/cases { name, snapshot } → { id }                # save a case file
GET  /api/cases/:id                                        # open a case file
DEL  /api/cases/:id
POST /api/graph/merge-nodes { nodes, edges, ids, city, country? }
POST /api/graph/merge { nodes, edges, add, city, country? } # case → working graph
POST /api/graph/interlink { nodes, edges, city, country? } # recompute keyword edges
POST /api/graph/deep-search { nodes, edges, nodeId, city, country? } # deep search on a case view
```

Recons persist in `data/meridian.db` (SQLite via `bun:sqlite`, gitignored).
Case files persist in `data/cases/` (JSON, gitignored).

## Run-request router (outside consumers)

The router lets trusted local programs (e.g. Milton) request recon runs
programmatically. A run is a recon plus router metadata: it goes through the
same collectors, but router runs execute **one at a time, FIFO**. A second
`POST` while one is active returns `{ status: "queued" }` and starts when the
first finishes. There is **no auth** — bind to localhost and treat the router
as a trusted-local interface.

Request a run and get called back on completion:

```bash
curl -s -X POST http://localhost:3005/api/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "city": "Madisonville, Cincinnati, OH",
    "sources": ["geocode", "wikipedia", "business"],
    "label": "milton nightly",
    "callback_url": "http://localhost:4010/hooks/meridian",
    "callback_headers": { "X-Hook-Secret": "s3cr3t" }
  }'
# → 202 { "run_id": "run_m3...", "status": "running" }
```

Then poll for the result:

```bash
curl -s http://localhost:3005/api/runs/run_m3... | bun -e '
  const r = JSON.parse(await new Response(Bun.stdin.stream()).text()).run;
  console.log(r.status, JSON.stringify(r.result));'
# → ready { "nodes": 42, "edges": 61,
#     "recon_url": "http://localhost:3005/api/recon/r...",
#     "export_url": "http://localhost:3005/api/recon/r.../export" }
```

Contract:

- `POST /api/runs` → `202 { run_id, status }` (`running` or `queued`).
  `city` is required; `sources` is filtered against the known collector keys
  (unknown keys are dropped, `geocode` always runs first); `label` is an
  optional tag (≤120 chars).
- **Business-only scope:** `POST /api/runs` (and `POST /api/recon`) accept
  `"business_only": true`. The run is restricted to sources classified as
  business data, plus `geocode` plumbing (which resolves the city to
  coordinates for the hub pin and searches nothing). Every other source —
  people, news, events, weather, aircraft, IP/infra, web scans, disasters,
  music, research, and any mixed source emitting those — is excluded. If an
  explicit `sources` list is given, it is intersected with the business
  allowlist; when nothing business remains the request fails with 400.
  The scope is stored on the run and exposed as `business_only` by
  `GET /api/runs` and `GET /api/runs/:id`.
- **Rule:** recon runs initiated from Milton are always business-only —
  Milton sends `business_only: true` on every `POST /api/runs`, with no
  opt-out. The launch form in the UI defaults to a full recon; its
  "business data only" toggle applies the same filter server-side.
- Business-data sources (`business: true` in `src/sources.ts`): `overpass`
  (business places), `business` (Wikidata companies), `gleif` and
  `gleifname` (legal-entity registry), `nonprofits` (ProPublica registry),
  `fdic` (bank registry), `secedgar` (SEC filers), `wikidataorg`
  (organizations), `hkcr` (HK company registry), `enhetsregisteret`
  (Norwegian entity registry). Each `SOURCE_DEFS` entry carries an explicit
  `business` boolean; a new source without one fails the test suite
  (default-deny, never default-allow).
- `callback_url` must be `http(s)`, else 400. `callback_headers` is an
  optional object with the same strict rules as webhook headers: RFC token
  names, ≤20 headers, name/value ≤2KB each, no CR/LF, and framing headers
  (`Host`, `Content-Length`, `Connection`, `Transfer-Encoding`) are rejected
  with 400.
- `GET /api/runs` → newest-first `{ run_id, city, label, status, created_at,
  started_at, finished_at, nodes, edges }`.
- `GET /api/runs/:id` → full status: `progress`, per-source `sources`
  states, and when finished a `result` summary `{ nodes, edges, recon_url,
  export_url }`. Callback header **values** are never exposed — `callback`
  shows only the header names, plus delivery `state` (`skipped`/`delivered`/
  `failed`), `http_status`, and `attempted_at`.
- Completion callback: when the run finishes (`ready`, `partial`, or
  `failed`), the router POSTs one attempt (15s timeout, no retry) to
  `callback_url`:
  `{ run_id, city, label, status, nodes, edges, result_url, export_url }`
  with the custom headers merged in (custom wins, framing headers stripped).
  The delivery outcome is recorded on the run; a failed callback never fails
  the run.
- Runs persist in the `runs` table in `data/meridian.db`. On boot, runs left
  in `running`/`queued` by a previous process return to `queued` and resume —
  never silently dropped, never run twice concurrently.

## Notes

- Bun + zero npm dependencies. The force layout, canvas renderer, and all
  parsers (Overpass JSON, RSS, SPARQL) are hand-rolled.
- Designed for the "8–10 hour sprint": collection takes ~30–60s; the sprint
  clock and the note tool are for the human hours that follow.
- Verified 2026-09-15: 106/106 for the graph analysis tools — 47/47 pure unit
  checks (node merge edge-union + detail/source preservation + provenance,
  group create/collapse/rename/ungroup/prune, case save→open round-trip,
  case-merge node/edge dedupe and the existing-wins conflict rule, keyword
  interlink recomputation after merges), 25/25 HTTP checks against a booted
  server (case CRUD, merge-nodes, merge, interlink, deep-search validation),
  34/34 DOM-stubbed frontend checks (cases panel render/open, selection
  toolbar, group containers + collapsed bubbles, hit-testing, marquee select,
  dirty-state title, merge resync pruning). No live network calls were made
  from the build environment.
- Verified 2026-09-15: 60/60 for the Keys screen — 24/24 key-store unit checks
  (env-wins resolution, masking, 0600 file, collector pickup with no restart),
  15/15 live-API checks against a booted server (set/get/clear, validation,
  full key never in any GET response), 21/21 DOM-stubbed frontend checks
  (modal render, save/test/clear flows). No live network calls were made from
  the build environment.
- Verified 2026-09-14: 64/64 collector + merge checks against stubbed sources
  (incl. GDELT/GLEIF/OpenSky/OpenAlex mapping, caps, empty-result and
  HTTP-error isolation), 17/17 keyword-interlink checks, 40/40 DOM-stubbed
  frontend checks (graph build, physics settle, filters, search, hit-testing,
  selection, scale behavior). No live network calls were made from the build
  environment — point it at a real city and confirm the sources light up green.
  Note: the GDELT articles[] shape and GLEIF's city filter parameter were wired
  defensively from public API knowledge (could not be re-verified against the
  live docs from the build environment); both collectors fail closed to an
  empty result / failed source row without breaking the recon.
