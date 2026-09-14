# meridian — graph OSINT recon

Land in a foreign city, launch a recon sprint, and watch social, cultural, and
business intel assemble itself into an interactive web of connected nodes.

`meridian` collects from **fourteen free, keyless sources** and lays the results out
as a force-directed node graph: the city sits pinned at the hub, everything
else — restaurants, museums, coworking spaces, embassies, hospitals, companies,
legal entities, notable people, researchers, artists, headlines, live aircraft,
currency, weather, local time — orbits it, connected by labeled edges.

## Run it

```bash
bun install   # nothing to install — zero dependencies
bun src/server.ts
# → http://localhost:3005
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
