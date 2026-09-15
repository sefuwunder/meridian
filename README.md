# meridian — graph OSINT recon

Land in a foreign city, launch a recon sprint, and watch social, cultural, and
business intel assemble itself into an interactive web of connected nodes.

`meridian` collects from **nineteen free, keyless sources** plus two optional
keyed-free ones (OCCRP Aleph needs a free API key to activate; OpenFEC works
out of the box on a low demo quota and accepts a free personal key for the
full rate). It lays the results out as a force-directed node graph: the city
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

Optional keys (never committed; read from environment):

```bash
OCCRP_API_KEY=...    # free account at data.occrp.org — activates the OCCRP Aleph collector
OPENFEC_API_KEY=...  # free personal key at api.open.fec.gov — raises OpenFEC from 30/hr to 1,000/hr
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
| 18 | OCCRP Aleph | entity search across 300+ investigative datasets (company registries, procurement, sanctions, leaks) on the Follow-the-Money model. Keyed-free: stays idle with a setup hint until `OCCRP_API_KEY` is set; never blocks the sprint. |
| 19 | urlscan.io | keyless search API: recent public web scans whose page URL mentions the city, expanded into domain → IP → ASN infra nodes with scan links and malicious-verdict flags. One request per recon (~30/min anonymous quota); HTTP 429 ends the source for the run, never retried. |
| 20 | ProPublica Nonprofit Explorer v2 | keyless: IRS nonprofits actually based in the recon city (filtered on the org's city field), with NTEE category and 501(c) subsection. One request per recon. |
| 21 | OpenFEC | keyed-free: campaign committees in the recon's US state plus itemized donors → person→committee "donated to" edges. Works on the built-in demo key at 30 req/hr; `OPENFEC_API_KEY` raises the limit. Two requests per recon. |

Every source is best-effort and independent: one dead API marks its row failed
in the collection panel and the sprint continues. Nothing is ever half-merged —
nodes dedupe by id, edges dedupe by endpoints + label, and edges pointing at
missing nodes are dropped.

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

## API

```
POST /api/recon            { city, sources? } → { id }          # launch (background)
GET  /api/recon                                            # list recons
GET  /api/recon/:id                                        # full graph + source states + progress
DEL  /api/recon/:id
POST /api/recon/:id/notes  { label, body, link_to? } → { node }
POST /api/recon/:id/deep-search { nodeId } → { addedNodes, addedEdges, keywords }
GET  /api/recon/:id/export                                 # JSON download
```

Recons persist in `data/meridian.db` (SQLite via `bun:sqlite`, gitignored).

## Notes

- Bun + zero npm dependencies. The force layout, canvas renderer, and all
  parsers (Overpass JSON, RSS, SPARQL) are hand-rolled.
- Designed for the "8–10 hour sprint": collection takes ~30–60s; the sprint
  clock and the note tool are for the human hours that follow.
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
