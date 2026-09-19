// meridian — canvas force-directed graph + recon UI. Zero dependencies.
(function () {
"use strict";

const COLORS = {
  city: "#f0b429", place: "#5b8cff", culture: "#3fd0b5", org: "#9a7bff",
  infra: "#8fa3c8", person: "#ef7fb8", news: "#ef6a6a", data: "#d99a2b", note: "#34c47c",
};
const TYPE_LABEL = {
  city: "city", place: "place", culture: "culture", org: "organisation",
  infra: "infrastructure", person: "person", news: "news", data: "fact", note: "analyst note",
};
const ALL_TYPES = Object.keys(COLORS);

// Performance: the draw loop runs every frame, so it must never blend
// alpha, blur shadows, or allocate gradients. Every translucent paint color
// is pre-blended once here against the app background (#070b14), the
// per-type node outline is pre-darkened once, and the dash pattern is a
// single shared array. The frame loop then only assigns solid colors.
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const m = 1 - amt;
  const r = Math.round(((n >> 16) & 255) * m), g = Math.round(((n >> 8) & 255) * m), b = Math.round((n & 255) * m);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
const EDGE_SOLID = "#1e2432";     // rgba(150,170,210,.16) over #070b14
const EDGE_KW_SOLID = "#151b27";  // rgba(150,170,210,.10) over #070b14
const EDGE_HOT_SOLID = "#876820"; // rgba(240,180,41,.55) over #070b14
const LABEL_HALO = "#04070d";     // rgba(4,6,12,.85) over #070b14
const LABEL_FILL = "#d6dbe5";     // rgba(232,237,247,.92) over #070b14
const MATCH_RING = "#d4d8dc";     // rgba(255,255,255,.8) over #070b14
const SEL_RING = "#f0b429";
const NODE_OUTLINE = {};
for (const t of ALL_TYPES) NODE_OUTLINE[t] = shade(COLORS[t], 0.45);
const KW_DASH = [4, 5]; // one shared array; setLineDash copies the pattern
const GROUP_BOX = "#0e1730";   // expanded group container, solid (no alpha per perf rules)
const GROUP_RING = "#33436e";  // group container outline
const GROUP_BUBBLE = "#16224a";// collapsed group bubble fill
const FONT = "11px -apple-system,Segoe UI,Roboto,sans-serif";
const FONT_CITY = "700 13px -apple-system,Segoe UI,Roboto,sans-serif";
const LABEL_MAX = 24; // canvas labels truncated past this length
function truncLabel(s) {
  s = s || "";
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + "…" : s;
}
function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Group layout geometry from live sim positions (world coords). Used by the
// draw pass and exposed for tests; the screen transform happens in draw().
function groupBoxes() {
  const out = [];
  for (const g of S.groups) {
    // collapsed groups keep their members' last known positions for the bubble,
    // so hidden members still count toward the geometry
    const members = g.members.map((id) => S.sim.get(id)).filter((n) => n && (g.collapsed || !n.hidden));
    if (!members.length) continue;
    let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18, cx = 0, cy = 0;
    for (const m of members) {
      x0 = Math.min(x0, m.x - m.r); y0 = Math.min(y0, m.y - m.r);
      x1 = Math.max(x1, m.x + m.r); y1 = Math.max(y1, m.y + m.r);
      cx += m.x; cy += m.y;
    }
    out.push({
      gid: g.id, name: g.name, collapsed: g.collapsed,
      x0, y0, x1, y1, cx: cx / members.length, cy: cy / members.length,
      count: members.length,
    });
  }
  return out;
}
function hitGroup(px, py) {
  for (const b of (S._bubbles || [])) {
    const dx = b.x - px, dy = b.y - py;
    if (dx * dx + dy * dy <= b.r * b.r) return b.gid;
  }
  return null;
}

const S = {
  recon: null,
  sim: new Map(),       // id -> {id,label,type,...,x,y,vx,vy,r,hidden,pinned}
  edges: [],            // {from,to,label,hidden}
  groups: [],           // {id,name,members:[node ids],collapsed} — persisted in case files
  multi: new Set(),     // multi-selected node ids (shift-click / shift-drag)
  docKind: "recon",     // "recon" | "case"
  caseId: null, caseName: "",
  dirty: false,         // unsaved merges/groups/edits — save to a case file
  marquee: null,        // {x0,y0,x1,y1} screen-space shift-drag rect
  _bubbles: [],         // collapsed-group hit targets, refreshed each draw
  view: { x: 0, y: 0, k: 1 },
  selected: null, hovered: null,
  typeFilter: new Set(ALL_TYPES),
  search: "",
  running: true, alpha: 1, slowPhys: false,
  dragging: null, panning: null, moved: false,
  pollTimer: null, clockTimer: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $("graph");
const ctx2d = canvas.getContext("2d");
const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));

// ---------------- graph model ----------------

// Well-connected nodes render larger than orphans: orphans sit at 5px,
// hubs grow to 16px, the city stays dominant at 20.
function radiusFor(n, degree) {
  if (n.type === "city") return 20;
  const base = n.type === "note" ? 7 : n.type === "org" ? 6 : 5;
  return Math.min(16, base + Math.min(degree || 0, 14) * 0.75);
}

function syncGraph() {
  // incremental: add new nodes/edges from the recon, reheat the sim
  if (!S.recon) return;
  const degree = {};
  for (const e of S.recon.edges) { degree[e.from] = (degree[e.from] || 0) + 1; degree[e.to] = (degree[e.to] || 0) + 1; }
  let added = 0;
  for (const n of S.recon.nodes) {
    if (S.sim.has(n.id)) {
      const s = S.sim.get(n.id);
      Object.assign(s, { label: n.label, type: n.type, subtype: n.subtype, source: n.source, detail: n.detail, url: n.url, lat: n.lat, lon: n.lon, deepSearched: n.deepSearched });
      s.r = radiusFor(n, degree[n.id]);
      continue;
    }
    // golden-angle spiral: new nodes land spread out, so even thousands
    // of nodes start in distinct grid cells instead of one dense disc
    const idx = S.sim.size, ga = Math.PI * (3 - Math.sqrt(5));
    const a = idx * ga, d = 50 + Math.sqrt(idx) * 26;
    const isCity = n.type === "city";
    S.sim.set(n.id, {
      ...n,
      x: isCity ? 0 : Math.cos(a) * d,
      y: isCity ? 0 : Math.sin(a) * d,
      vx: 0, vy: 0, r: radiusFor(n, degree[n.id]),
      hidden: false, pinned: isCity,
    });
    added++;
  }
  const ekey = (e) => e.from + ">" + e.to + ":" + e.label;
  const have = new Set(S.edges.map(ekey));
  for (const e of S.recon.edges) {
    if (have.has(ekey(e)) || !S.sim.has(e.from) || !S.sim.has(e.to)) continue;
    S.edges.push({ ...e, hidden: false });
    have.add(ekey(e));
  }
  if (added) { S.alpha = 1; kick(); }
  applyFilters();
  updateCounts();
}

function visibleNodes() {
  const out = [];
  for (const n of S.sim.values()) if (!n.hidden) out.push(n);
  return out;
}
function visibleEdges() {
  return S.edges.filter((e) => !e.hidden);
}

function applyFilters() {
  const q = S.search.trim().toLowerCase();
  const collapsedIds = new Set();
  for (const g of S.groups) if (g.collapsed) for (const id of g.members) collapsedIds.add(id);
  for (const n of S.sim.values()) {
    const typeHidden = !S.typeFilter.has(n.type);
    const queryHidden = Boolean(q &&
      !(n.label || "").toLowerCase().includes(q) &&
      !(n.subtype || "").toLowerCase().includes(q));
    n.hidden = typeHidden || queryHidden || collapsedIds.has(n.id);
  }
  const hiddenIds = new Set();
  for (const n of S.sim.values()) if (n.hidden) hiddenIds.add(n.id);
  for (const e of S.edges) e.hidden = hiddenIds.has(e.from) || hiddenIds.has(e.to);
  if (S.selected && S.sim.get(S.selected)?.hidden) S.selected = null;
  updateCounts();
  renderChips();
  draw();
}

// ---------------- physics ----------------

function tick() {
  const nodes = visibleNodes();
  const edges = visibleEdges();
  const n = nodes.length;
  if (!n) return;
  const alpha = S.dragging ? 0.35 : S.alpha;

  // repulsion via spatial hash: identical forces to the old O(n^2) loop,
  // but each node only tests neighbors in adjacent grid cells (~O(n))
  const CELL = 180;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const p = nodes[i];
    const gk = Math.floor(p.x / CELL) + ":" + Math.floor(p.y / CELL);
    let cell = grid.get(gk);
    if (!cell) grid.set(gk, (cell = []));
    cell.push(i);
  }
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    if (a.pinned) continue;
    const ax = a.x, ay = a.y, ar = a.r;
    const cx = Math.floor(ax / CELL), cy = Math.floor(ay / CELL);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const cell = grid.get((cx + ox) + ":" + (cy + oy));
      if (!cell) continue;
      for (let ci = 0; ci < cell.length; ci++) {
        const j = cell[ci];
        if (j <= i) continue;
        const b = nodes[j];
        let dx = ax - b.x, dy = ay - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 1; }
        const minD = ar + b.r + 26;
        if (d2 > minD * minD * 9) continue;
        const d = Math.sqrt(d2);
        const f = Math.min(5200 / d2, 40) * alpha;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
      }
    }
  }
  // springs
  for (const e of edges) {
    const a = S.sim.get(e.from), b = S.sim.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const rest = 120 + (a.r + b.r) * 1.4;
    const f = ((d - rest) / d) * 0.045 * alpha;
    if (!a.pinned) { a.vx += dx * f; a.vy += dy * f; }
    if (!b.pinned) { b.vx -= dx * f; b.vy -= dy * f; }
  }
  // gentle gravity toward hub
  for (const nd of nodes) {
    if (nd.pinned || nd === S.dragging) continue;
    nd.vx += -nd.x * 0.006 * alpha;
    nd.vy += -nd.y * 0.006 * alpha;
  }
  // integrate
  for (const nd of nodes) {
    if (nd.pinned) { nd.vx = nd.vy = 0; continue; }
    if (nd === S.dragging) { nd.vx = nd.vy = 0; continue; }
    nd.vx *= 0.86; nd.vy *= 0.86;
    nd.x += nd.vx; nd.y += nd.vy;
  }
  if (!S.dragging) { S.alpha *= 0.984; if (S.alpha < 0.008) S.alpha = 0; }
}

// ---------------- rendering ----------------

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, r.width * dpr);
  canvas.height = Math.max(1, r.height * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function w2s(x, y) {
  const r = canvas.getBoundingClientRect();
  return [(x - S.view.x) * S.view.k + r.width / 2, (y - S.view.y) * S.view.k + r.height / 2];
}
function s2w(px, py) {
  const r = canvas.getBoundingClientRect();
  return [(px - r.width / 2) / S.view.k + S.view.x, (py - r.height / 2) / S.view.k + S.view.y];
}

function draw() {
  // One layout read per frame (was: one per node + one per edge via w2s).
  const R = canvas.getBoundingClientRect();
  const W = R.width, H = R.height, k = S.view.k;
  const vx = S.view.x, vy = S.view.y, ox = W / 2, oy = H / 2;
  const c = ctx2d;
  c.clearRect(0, 0, W, H);
  const nodes = visibleNodes(), edges = visibleEdges(), sel = S.selected;

  // ---- edges: three batched passes, one strokeStyle + one stroke each.
  // Solid colors only (no alpha), the dash list toggled exactly twice.
  const isHot = (e) => sel && (e.from === sel || e.to === sel);
  const isKw = (e) => e.kind === "keyword" && !isHot(e);
  c.lineWidth = 1;
  const strokePass = (pred, style, dash) => {
    c.strokeStyle = style;
    if (dash) c.setLineDash(dash);
    c.beginPath();
    let any = false;
    for (const e of edges) {
      if (!pred(e)) continue;
      const a = S.sim.get(e.from), b = S.sim.get(e.to);
      if (!a || !b) continue;
      const ax = (a.x - vx) * k + ox, ay = (a.y - vy) * k + oy;
      const bx = (b.x - vx) * k + ox, by = (b.y - vy) * k + oy;
      if ((ax < -80 && bx < -80) || (ax > W + 80 && bx > W + 80) ||
          (ay < -60 && by < -60) || (ay > H + 60 && by > H + 60)) continue;
      c.moveTo(ax, ay); c.lineTo(bx, by); any = true;
    }
    if (any) c.stroke();
    if (dash) c.setLineDash([]);
  };
  strokePass((e) => !isHot(e) && !isKw(e), EDGE_SOLID, null);
  strokePass(isKw, EDGE_KW_SOLID, KW_DASH);
  strokePass(isHot, EDGE_HOT_SOLID, null);

  // ---- groups: expanded groups get a labeled container behind their
  // members; collapsed groups render as one bubble at the member centroid.
  // Solid colors only, matching the frame-loop perf rules.
  S._bubbles = [];
  for (const gb of groupBoxes()) {
    if (gb.collapsed) {
      const sx = (gb.cx - vx) * k + ox, sy = (gb.cy - vy) * k + oy;
      if (sx < -80 || sy < -80 || sx > W + 80 || sy > H + 80) continue;
      const br = Math.max(20, 12 + Math.min(gb.count, 20));
      S._bubbles.push({ gid: gb.gid, x: sx, y: sy, r: br + 6 });
      c.beginPath(); c.arc(sx, sy, br, 0, Math.PI * 2);
      c.fillStyle = GROUP_BUBBLE; c.fill();
      const gsel = sel === "group:" + gb.gid;
      c.lineWidth = gsel ? 3 : 1.5;
      c.strokeStyle = gsel ? "#ffffff" : GROUP_RING;
      c.stroke();
      const txt = truncLabel(gb.name) + " · " + gb.count;
      c.font = FONT; c.textAlign = "center"; c.lineWidth = 3; c.strokeStyle = LABEL_HALO;
      c.strokeText(txt, sx, sy + 4);
      c.fillStyle = LABEL_FILL; c.fillText(txt, sx, sy + 4);
    } else {
      const pad = 30 / k + 14;
      const sx0 = (gb.x0 - pad - vx) * k + ox, sy0 = (gb.y0 - pad - vy) * k + oy;
      const sx1 = (gb.x1 + pad - vx) * k + ox, sy1 = (gb.y1 + pad - vy) * k + oy;
      roundRectPath(c, sx0, sy0, sx1 - sx0, sy1 - sy0, 12);
      c.fillStyle = GROUP_BOX; c.fill();
      c.lineWidth = 1.5; c.strokeStyle = GROUP_RING; c.stroke();
      c.font = FONT; c.textAlign = "left"; c.lineWidth = 3; c.strokeStyle = LABEL_HALO;
      c.strokeText(truncLabel(gb.name), sx0 + 10, sy0 + 20);
      c.fillStyle = LABEL_FILL; c.fillText(truncLabel(gb.name), sx0 + 10, sy0 + 20);
    }
  }

  // ---- nodes: one fill + one stroke per type (was: per node).
  // No shadowBlur anywhere — selected / hovered / city nodes get solid
  // rings instead, and search matches keep their light ring.
  const q = S.search.trim().toLowerCase();
  const rScale = Math.min(1.6, Math.max(0.7, k));
  const labels = []; // [text, x, y, isSel, isCity]
  const rings = [];  // [x, y, rad, style, width]
  for (const t of ALL_TYPES) {
    c.fillStyle = COLORS[t];
    c.beginPath();
    let any = false;
    for (const nd of nodes) {
      if (nd.type !== t) continue;
      const x = (nd.x - vx) * k + ox, y = (nd.y - vy) * k + oy;
      if (x < -60 || y < -40 || x > W + 60 || y > H + 40) continue;
      const rad = nd.r * rScale;
      c.moveTo(x + rad, y); // keep arcs in one path from connecting
      c.arc(x, y, rad, 0, Math.PI * 2);
      any = true;
      const isSel = sel === nd.id, isHov = S.hovered === nd.id;
      const match = q && (nd.label || "").toLowerCase().includes(q);
      if (match && !isSel) rings.push([x, y, rad + 4, MATCH_RING, 1.5]);
      if (isSel) rings.push([x, y, rad, "#ffffff", 3]);
      else if (S.multi.has(nd.id)) rings.push([x, y, rad + 4, SEL_RING, 2]);
      else if (isHov) rings.push([x, y, rad + 4, SEL_RING, 2]);
      else if (t === "city") rings.push([x, y, rad + 5, SEL_RING, 2]);
      // at overview zoom only well-connected hubs earn a label; zoom in to name everything
      if (t === "city" || isSel || isHov || k >= 1.6 || nd.r >= 10.5 || match)
        labels.push([truncLabel(nd.label), x, y + rad + 13, isSel, t === "city"]);
    }
    if (any) {
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = NODE_OUTLINE[t];
      c.stroke();
    }
  }

  // ---- highlight rings: a handful per frame, all solid ----
  for (const [x, y, rad, style, w] of rings) {
    c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2);
    c.strokeStyle = style; c.lineWidth = w; c.stroke();
  }

  // ---- labels: two batched passes, truncated, solid halo ----
  c.textAlign = "center";
  c.lineWidth = 3;
  c.strokeStyle = LABEL_HALO;
  const paintLabels = (font, items) => {
    if (!items.length) return;
    c.font = font;
    for (const [text, x, y, isSel] of items) {
      c.strokeText(text, x, y);
      c.fillStyle = isSel ? "#ffffff" : LABEL_FILL;
      c.fillText(text, x, y);
    }
  };
  paintLabels(FONT_CITY, labels.filter((l) => l[4]));
  paintLabels(FONT, labels.filter((l) => !l[4]));
}

// The render loop sleeps when the layout settles: wake() reheats it,
// kick() ensures it's running. Idle graphs cost zero CPU. When physics
// itself is heavy (thousands of nodes), it drops to every other frame so
// pan/zoom/draw stay at full rate while the layout catches up.
let rafId = 0, physTick = 0, physAvg = 8;
const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
function kick() { if (!rafId && S.running) rafId = raf(loop); }
function wake() { S.alpha = Math.max(S.alpha, 0.5); kick(); }
function loop() {
  rafId = 0;
  if (S.running && (S.alpha > 0 || S.dragging)) {
    physTick++;
    if (!S.slowPhys || physTick % 2 === 1 || S.dragging) {
      const t0 = nowMs();
      tick();
      physAvg = physAvg * 0.9 + (nowMs() - t0) * 0.1;
      S.slowPhys = physAvg > 24;
    }
    draw(); kick();
  } else draw();
}

// ---------------- interaction ----------------

function hitNode(px, py) {
  const [wx, wy] = s2w(px, py);
  const nodes = visibleNodes();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    const tol = (nd.r + 6) / S.view.k;
    const dx = nd.x - wx, dy = nd.y - wy;
    if (dx * dx + dy * dy <= tol * tol) return nd;
  }
  return null;
}

canvas.addEventListener("mousedown", (e) => {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (e.shiftKey) {
    // multi-select: shift-click toggles a node, shift-drag marquees
    const gid = hitGroup(px, py);
    const nd = gid ? null : hitNode(px, py);
    if (nd) { toggleMulti(nd.id); S.moved = true; return; }
    S.marquee = { x0: px, y0: py, x1: px, y1: py };
    $("marquee").hidden = false;
    positionMarquee();
    return;
  }
  const nd = hitNode(px, py);
  S.moved = false;
  if (nd) {
    S.dragging = nd;
    S.dragX = px; S.dragY = py;
    kick();
  } else {
    const gid = hitGroup(px, py);
    if (gid) { selectNode("group:" + gid); S.moved = true; return; }
    S.panning = { x: px, y: py, vx: S.view.x, vy: S.view.y };
  }
  canvas.classList.add("dragging");
});
window.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (S.marquee) {
    S.marquee.x1 = px; S.marquee.y1 = py;
    positionMarquee();
    return;
  }
  if (S.dragging) {
    const [wx, wy] = s2w(px, py);
    S.dragging.x = wx; S.dragging.y = wy;
    S.moved = true;
  } else if (S.panning) {
    if (Math.abs(px - S.panning.x) + Math.abs(py - S.panning.y) > 3) S.moved = true;
    S.view.x = S.panning.vx - (px - S.panning.x) / S.view.k;
    S.view.y = S.panning.vy - (py - S.panning.y) / S.view.k;
    draw();
  } else if (e.target === canvas) {
    const nd = hitNode(px, py);
    const hov = nd ? nd.id : null;
    if (hov !== S.hovered) { S.hovered = hov; draw(); }
    canvas.classList.toggle("over-node", !!nd);
  }
});
window.addEventListener("mouseup", (e) => {
  const wasDrag = S.dragging, wasPan = S.panning;
  if (S.marquee) {
    const m = S.marquee;
    S.marquee = null;
    $("marquee").hidden = true;
    marqueeSelect(m);
    draw();
    return;
  }
  if (wasDrag && !S.moved) selectNode(wasDrag.id);
  if (wasDrag) { S.alpha = Math.max(S.alpha, 0.4); kick(); }
  if (wasPan && !S.moved && S.multi.size) clearMulti(); // empty click clears the selection
  S.dragging = null; S.panning = null;
  canvas.classList.remove("dragging");
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const [wx, wy] = s2w(px, py);
  const k2 = Math.min(4, Math.max(0.2, S.view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  S.view.x = wx - (px - r.width / 2) / k2;
  S.view.y = wy - (py - r.height / 2) / k2;
  S.view.k = k2;
  draw();
}, { passive: false });
window.addEventListener("resize", resize);

function centerOn(id) {
  const nd = S.sim.get(id);
  if (!nd) return;
  S.view.x = nd.x; S.view.y = nd.y;
  if (S.view.k < 0.9) S.view.k = 0.9;
  draw();
}
function fit() {
  const nodes = visibleNodes();
  if (!nodes.length) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const nd of nodes) {
    x0 = Math.min(x0, nd.x); y0 = Math.min(y0, nd.y);
    x1 = Math.max(x1, nd.x); y1 = Math.max(y1, nd.y);
  }
  const r = canvas.getBoundingClientRect();
  const k = Math.min(2.2, Math.max(0.25, Math.min((r.width - 120) / Math.max(1, x1 - x0), (r.height - 120) / Math.max(1, y1 - y0))));
  S.view.k = k;
  S.view.x = (x0 + x1) / 2; S.view.y = (y0 + y1) / 2;
  draw();
}

// ---------------- multi-select / dirty state ----------------

function toggleMulti(id) {
  if (S.multi.has(id)) S.multi.delete(id);
  else S.multi.add(id);
  updateSelBar();
  draw();
}
function clearMulti() {
  S.multi.clear();
  updateSelBar();
  draw();
}
function updateSelBar() {
  const bar = $("selBar");
  const n = S.multi.size;
  bar.hidden = n === 0;
  if (!n) return;
  $("selCount").textContent = n + " selected";
  const bm = $("btnMerge");
  bm.disabled = n < 2;
  bm.textContent = n >= 2 ? `merge ${n} nodes` : "merge";
}
function positionMarquee() {
  const m = S.marquee, el = $("marquee");
  if (!m || !el) return;
  el.style.left = Math.min(m.x0, m.x1) + "px";
  el.style.top = Math.min(m.y0, m.y1) + "px";
  el.style.width = Math.abs(m.x1 - m.x0) + "px";
  el.style.height = Math.abs(m.y1 - m.y0) + "px";
}
function marqueeSelect(m) {
  const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
  const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
  if (x1 - x0 < 6 && y1 - y0 < 6) return;
  for (const nd of visibleNodes()) {
    const [sx, sy] = w2s(nd.x, nd.y);
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) S.multi.add(nd.id);
  }
  updateSelBar();
}

// Any merge/group/edit marks the view dirty: the case file (or a fresh save)
// is the durable layer, so the title carries an unsaved-changes dot.
function markDirty() {
  if (!S.dirty) { S.dirty = true; renderTitle(); }
}
function renderTitle() {
  let t;
  if (S.docKind === "case") t = "📁 " + (S.caseName || "case");
  else if (S.recon) t = `${S.recon.city}${S.recon.country ? " · " + S.recon.country : ""} — ${S.recon.status}`;
  else t = "no recon loaded";
  if (S.dirty) t += " ●";
  $("reconTitle").textContent = t;
  $("reconTitle").title = S.dirty ? "unsaved changes — save to a case file" : "";
}

// Rebuild the sim from the working document after a merge/graph-merge:
// drop absorbed nodes, union edges, and let syncGraph place the newcomers
// on the golden-angle spiral. Group memberships and selections are pruned
// to surviving ids.
function resyncFromDoc() {
  const keep = new Set(S.recon.nodes.map((n) => n.id));
  for (const id of [...S.sim.keys()]) if (!keep.has(id)) S.sim.delete(id);
  const ekey = (e) => e.from + ">" + e.to + ":" + e.label;
  const valid = new Set(S.recon.edges.map(ekey));
  S.edges = S.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && valid.has(ekey(e)));
  S.groups = S.groups
    .map((g) => ({ ...g, members: g.members.filter((id) => keep.has(id)) }))
    .filter((g) => g.members.length > 0);
  S.multi = new Set([...S.multi].filter((id) => keep.has(id)));
  if (S.selected && !keep.has(S.selected) && !String(S.selected).startsWith("group:")) S.selected = null;
  if (S.selected && String(S.selected).startsWith("group:") &&
      !S.groups.some((g) => g.id === S.selected.slice(6))) S.selected = null;
  syncGraph();
  renderGroups();
  updateSelBar();
}

// ---------------- selection + detail ----------------

function neighborsOf(id) {
  const out = [];
  for (const e of S.edges) {
    if (e.hidden) continue;
    if (e.from === id && S.sim.has(e.to)) out.push({ edge: e, node: S.sim.get(e.to), dir: "out" });
    else if (e.to === id && S.sim.has(e.from)) out.push({ edge: e, node: S.sim.get(e.from), dir: "in" });
  }
  return out;
}

function selectNode(id) {
  S.selected = id;
  const el = $("nodeDetail");
  if (id && String(id).startsWith("group:")) { renderGroupDetail(String(id).slice(6)); draw(); return; }
  if (!id || !S.sim.get(id)) { el.innerHTML = '<div class="empty">click any node in the web</div>'; return; }
  const nd = S.sim.get(id);
  const nb = neighborsOf(id).filter((x) => !x.node.hidden).slice(0, 40);
  const color = COLORS[nd.type] || "#fff";
  el.innerHTML = "";
  const head = document.createElement("div"); head.className = "np";
  head.innerHTML = `<span class="sw" style="width:12px;height:12px;border-radius:50%;background:${color};display:inline-block"></span>
    <h4></h4><span class="pill" style="background:${color}22;color:${color}">${TYPE_LABEL[nd.type] || nd.type}</span>`;
  head.querySelector("h4").textContent = nd.label;
  head.querySelector("h4").title = nd.label || "";
  el.appendChild(head);
  const meta = document.createElement("div");
  meta.innerHTML =
    (nd.subtype ? `<div class="kv"><b>${escapeHtml(nd.subtype)}</b></div>` : "") +
    `<div class="kv">source · <b>${escapeHtml(nd.source || "—")}</b></div>` +
    (nd.lat != null ? `<div class="kv">${Number(nd.lat).toFixed(4)}, ${Number(nd.lon).toFixed(4)}</div>` : "");
  el.appendChild(meta);
  const inGroups = S.groups.filter((g) => g.members.includes(id));
  if (inGroups.length) {
    const gw = document.createElement("div");
    gw.className = "kv";
    gw.style.marginTop = "6px";
    gw.appendChild(document.createTextNode("in group · "));
    for (const g of inGroups) {
      const b = document.createElement("button");
      b.className = "linklike";
      b.textContent = g.name;
      b.onclick = () => selectNode("group:" + g.id);
      gw.appendChild(b);
      gw.appendChild(document.createTextNode(" "));
    }
    el.appendChild(gw);
  }
  if (nd.detail) { const b = document.createElement("div"); b.className = "body"; b.textContent = nd.detail; el.appendChild(b); }
  if (nd.url) { const a = document.createElement("a"); a.href = nd.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = nd.url; el.appendChild(a); }
  // directed deep search: keywords from this node's content -> new nodes grafted on
  const dsLabel = nd.deepSearched ? "deep search again" : "deep search";
  const dsBtn = document.createElement("button");
  dsBtn.className = "dsbtn";
  dsBtn.textContent = dsLabel;
  dsBtn.title = "search GDELT, Wikipedia & Wikidata for this node's keywords";
  dsBtn.onclick = async () => {
    if (!S.recon) return;
    dsBtn.disabled = true;
    dsBtn.textContent = "searching…";
    try {
      if (S.docKind === "case") {
        // case views graft into the working document, not the recon store
        const r = await api("/api/graph/deep-search", {
          method: "POST",
          body: JSON.stringify({
            nodeId: id, nodes: S.recon.nodes, edges: S.recon.edges,
            city: S.recon.city, country: S.recon.country || null,
          }),
        });
        S.recon.nodes = r.nodes; S.recon.edges = r.edges;
        resyncFromDoc(); markDirty();
        selectNode(id);
      } else {
        await api(`/api/recon/${S.recon.id}/deep-search`, {
          method: "POST", body: JSON.stringify({ nodeId: id }),
        });
        await loadRecon(S.recon.id); // incremental re-sync via syncGraph
        selectNode(id); // refresh the panel → "deep search again"
      }
    } catch (e) {
      alert("deep search failed: " + e.message);
      dsBtn.disabled = false;
      dsBtn.textContent = dsLabel;
    }
  };
  el.appendChild(dsBtn);
  if (nb.length) {
    const t = document.createElement("div"); t.className = "kv"; t.style.marginTop = "10px";
    t.innerHTML = `<b>${nb.length}</b> connection${nb.length === 1 ? "" : "s"}`;
    el.appendChild(t);
    const list = document.createElement("div"); list.className = "neighbors";
    for (const { edge, node } of nb) {
      const d = document.createElement("div");
      const c = COLORS[node.type] || "#fff";
      d.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${c};flex:none"></span><span></span><span class="el"></span>`;
      d.querySelector("span:nth-child(2)").textContent = node.label;
      d.querySelector(".el").textContent = edge.label;
      d.onclick = () => { selectNode(node.id); centerOn(node.id); };
      list.appendChild(d);
    }
    el.appendChild(list);
  }
  draw();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- filters / search ----------------

function renderChips() {
  const box = $("typeChips");
  box.innerHTML = "";
  const counts = {};
  for (const nd of S.sim.values()) if (!nd.hidden || true) counts[nd.type] = (counts[nd.type] || 0) + 1;
  for (const t of ALL_TYPES) {
    if (!counts[t]) continue;
    const c = document.createElement("div");
    c.className = "chip" + (S.typeFilter.has(t) ? "" : " off");
    c.innerHTML = `<span class="sw" style="background:${COLORS[t]}"></span><span></span>`;
    c.querySelector("span:last-child").textContent = `${TYPE_LABEL[t]} · ${counts[t]}`;
    c.onclick = () => {
      S.typeFilter.has(t) ? S.typeFilter.delete(t) : S.typeFilter.add(t);
      wake();
      applyFilters();
    };
    box.appendChild(c);
  }
}

function searchNodes(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const nd of S.sim.values()) {
    if ((nd.label || "").toLowerCase().includes(q) || (nd.subtype || "").toLowerCase().includes(q)) out.push(nd);
  }
  return out.sort((a, b) => a.label.length - b.label.length).slice(0, 12);
}

$("searchInput").addEventListener("input", (e) => {
  S.search = e.target.value;
  const box = $("searchResults");
  const hits = searchNodes(S.search);
  if (!hits.length || !S.search.trim()) { box.hidden = true; box.innerHTML = ""; }
  else {
    box.hidden = false; box.innerHTML = "";
    for (const nd of hits) {
      const d = document.createElement("div");
      d.innerHTML = `<span class="ty"></span><span></span>`;
      d.querySelector(".ty").textContent = TYPE_LABEL[nd.type] || nd.type;
      d.querySelector("span:last-child").textContent = nd.label;
      d.onclick = () => { box.hidden = true; selectNode(nd.id); centerOn(nd.id); };
      box.appendChild(d);
    }
  }
  applyFilters();
});
$("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const hits = searchNodes(S.search);
    if (hits[0]) { $("searchResults").hidden = true; selectNode(hits[0].id); centerOn(hits[0].id); }
  }
  if (e.key === "Escape") { e.target.value = ""; S.search = ""; $("searchResults").hidden = true; applyFilters(); }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".stage-top")) $("searchResults").hidden = true;
});

// ---------------- recon API wiring ----------------

async function api(path, opts) {
  const r = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...((opts && opts.headers) || {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function updateCounts() {
  const nv = visibleNodes().length, ev = visibleEdges().length;
  const total = S.sim.size;
  $("graphCounts").textContent = total ? `${nv} nodes · ${ev} edges` : "";
}

async function loadList() {
  try {
    const { recons } = await api("/api/recon");
    const box = $("reconList");
    box.innerHTML = "";
    for (const rc of recons) {
      const li = document.createElement("li");
      if (S.recon && S.recon.id === rc.id) li.className = "active";
      li.innerHTML = `<div class="t"><span></span><span style="display:flex;gap:6px;align-items:center"><span class="pill ${rc.status}">${rc.status}</span><button class="x" title="delete">×</button></span></div>
        <div class="m"></div>`;
      li.querySelector(".t span").textContent = rc.city;
      li.querySelector(".m").textContent = `${rc.country || ""} · ${rc.nodes} nodes · ${new Date(rc.created_at).toLocaleDateString()}`;
      li.querySelector(".x").onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`delete recon "${rc.city}"?`)) return;
        await api(`/api/recon/${rc.id}`, { method: "DELETE" });
        if (S.recon && S.recon.id === rc.id) { S.recon = null; S.sim.clear(); S.edges = []; S.selected = null; S.groups = []; S.multi.clear(); S.dirty = false; renderTitle(); renderGroups(); updateSelBar(); selectNode(null); }
        loadList(); updateCounts();
      };
      li.onclick = () => loadRecon(rc.id);
      box.appendChild(li);
    }
  } catch { /* offline */ }
}

function stopPoll() { if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; } }
function stopClock() { if (S.clockTimer) { clearInterval(S.clockTimer); S.clockTimer = null; } }

function startClock(createdAt) {
  stopClock();
  const el = $("sprintClock");
  const pad = (v) => String(v).padStart(2, "0");
  const update = () => {
    const s = Math.floor((Date.now() - createdAt) / 1000);
    el.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };
  update();
  S.clockTimer = setInterval(update, 1000);
}

function renderSources(sources, progress) {
  const panel = $("collectPanel");
  panel.hidden = false;
  const pct = progress.total ? Math.round((100 * progress.done) / progress.total) : 0;
  $("progressBar").style.width = pct + "%";
  $("progressLabel").textContent = progress.current || `${progress.done}/${progress.total} sources`;
  const box = $("sourceList");
  box.innerHTML = "";
  for (const s of sources) {
    const li = document.createElement("li");
    li.dataset.state = s.state;
    li.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="nt"></span>`;
    li.querySelector(".nm").textContent = s.label;
    li.querySelector(".nt").textContent = s.note + (s.ms ? ` · ${(s.ms / 1000).toFixed(1)}s` : "");
    li.title = s.note || "";
    box.appendChild(li);
  }
}

function renderDossier(facts, cityNode) {
  const panel = $("dossierPanel");
  const items = [];
  if (facts.localTime) items.push(["local time", `${facts.localTime}${facts.localDate ? " · " + facts.localDate : ""}`]);
  if (facts.temp) items.push(["weather", `${facts.temp} · ${facts.condition || ""}`]);
  if (facts.currency) items.push(["currency", facts.currency + (facts.usdRate ? ` (${facts.usdRate})` : "")]);
  if (facts.languages) items.push(["languages", facts.languages]);
  if (facts.callingCode) items.push(["dial code", facts.callingCode]);
  if (facts.region) items.push(["region", facts.region]);
  if (!items.length && !(cityNode && cityNode.detail)) { panel.hidden = true; return; }
  panel.hidden = false;
  const box = $("dossierFacts");
  box.innerHTML = "";
  for (const [k, v] of items) {
    const d = document.createElement("div"); d.className = "fact";
    d.innerHTML = `<div class="k"></div><div class="v"></div>`;
    d.querySelector(".k").textContent = k; d.querySelector(".v").textContent = v;
    box.appendChild(d);
  }
  if (cityNode && cityNode.detail) {
    const d = document.createElement("div"); d.className = "fact"; d.style.gridColumn = "1/-1";
    d.innerHTML = `<div class="k">profile</div><div class="v" style="font-weight:400;font-size:12px;max-height:120px;overflow-y:auto"></div>`;
    d.querySelector(".v").textContent = cityNode.detail.slice(0, 600);
    box.appendChild(d);
  }
}

async function loadRecon(id, poll) {
  stopPoll();
  try {
    const { recon } = await api(`/api/recon/${id}`);
    const isNew = !S.recon || S.recon.id !== id;
    S.recon = recon;
    if (isNew) {
      S.sim.clear(); S.edges = []; S.selected = null;
      S.view = { x: 0, y: 0, k: 1 };
      S.typeFilter = new Set(ALL_TYPES);
      S.groups = []; S.multi.clear();
      S.docKind = "recon"; S.caseId = null; S.caseName = ""; S.dirty = false;
      renderGroups(); updateSelBar();
      selectNode(null);
    }
    syncGraph();
    const cityNode = recon.nodes.find((n) => n.type === "city");
    renderTitle();
    renderDossier(recon.facts || {}, cityNode);
    renderSources(recon.sources || [], recon.progress || {});
    if (recon.status === "collecting") $("collectPanel").hidden = false;
    startClock(recon.created_at);
    loadList();
    if (recon.status === "collecting" || poll) {
      S.pollTimer = setTimeout(() => loadRecon(id, true), 2500);
    }
    if (isNew) setTimeout(fit, 600);
  } catch { /* ignore */ }
}

// ---------------- groups ----------------

function renderGroupDetail(gid) {
  const g = S.groups.find((x) => x.id === gid);
  const el = $("nodeDetail");
  if (!g) { el.innerHTML = '<div class="empty">group gone</div>'; return; }
  el.innerHTML = "";
  const head = document.createElement("div"); head.className = "np";
  head.innerHTML = `<h4></h4><span class="pill">group · ${g.members.length}</span>`;
  head.querySelector("h4").textContent = g.name;
  el.appendChild(head);
  const t = document.createElement("div"); t.className = "kv";
  t.textContent = g.collapsed ? "collapsed — members hidden from the graph" : "expanded";
  el.appendChild(t);
  const list = document.createElement("div"); list.className = "neighbors";
  for (const id of g.members) {
    const n = S.sim.get(id);
    const d = document.createElement("div");
    d.innerHTML = `<span></span>`;
    d.querySelector("span").textContent = n ? n.label : id + " (gone)";
    d.onclick = () => { if (n) { selectNode(id); centerOn(id); } };
    list.appendChild(d);
  }
  el.appendChild(list);
  const row = document.createElement("div"); row.className = "btnrow";
  const bT = document.createElement("button");
  bT.textContent = g.collapsed ? "expand" : "collapse";
  bT.onclick = () => { g.collapsed = !g.collapsed; markDirty(); renderGroups(); renderGroupDetail(gid); applyFilters(); };
  const bR = document.createElement("button");
  bR.textContent = "rename";
  bR.onclick = () => {
    const v = prompt("group name", g.name);
    if (v && v.trim()) { g.name = v.trim().slice(0, 80); markDirty(); renderGroups(); renderGroupDetail(gid); draw(); }
  };
  const bU = document.createElement("button");
  bU.textContent = "ungroup";
  bU.onclick = () => {
    if (!confirm(`ungroup "${g.name}"? members stay in the graph.`)) return;
    S.groups = S.groups.filter((x) => x.id !== g.id);
    markDirty(); renderGroups(); applyFilters(); selectNode(null);
  };
  row.append(bT, bR, bU);
  el.appendChild(row);
}

function renderGroups() {
  const box = $("groupList");
  box.innerHTML = "";
  if (!S.groups.length) {
    box.innerHTML = '<div class="empty">no groups yet — shift-click nodes to select, then group them</div>';
    return;
  }
  for (const g of S.groups) {
    const row = document.createElement("div"); row.className = "grouprow";
    const nm = document.createElement("span"); nm.className = "gname"; nm.textContent = g.name;
    nm.title = "open group";
    nm.onclick = () => selectNode("group:" + g.id);
    const cnt = document.createElement("span"); cnt.className = "pill";
    cnt.textContent = g.members.length + (g.collapsed ? " · collapsed" : "");
    const bT = document.createElement("button");
    bT.textContent = g.collapsed ? "expand" : "collapse";
    bT.title = g.collapsed ? "show members" : "hide members";
    bT.onclick = () => { g.collapsed = !g.collapsed; markDirty(); renderGroups(); applyFilters(); };
    const bS = document.createElement("button");
    bS.textContent = "select"; bS.title = "select members";
    bS.onclick = () => { S.multi = new Set(g.members.filter((id) => S.sim.has(id))); updateSelBar(); draw(); };
    const bU = document.createElement("button");
    bU.textContent = "ungroup"; bU.className = "danger"; bU.title = "remove the group, keep members";
    bU.onclick = () => {
      if (!confirm(`ungroup "${g.name}"? members stay in the graph.`)) return;
      S.groups = S.groups.filter((x) => x.id !== g.id);
      if (S.selected === "group:" + g.id) selectNode(null);
      markDirty(); renderGroups(); applyFilters();
    };
    row.append(nm, cnt, bT, bS, bU);
    box.appendChild(row);
  }
}

// ---------------- merge nodes ----------------

$("btnMerge").onclick = () => {
  const ids = [...S.multi];
  if (ids.length < 2) return;
  const nodes = ids.map((id) => S.sim.get(id)).filter(Boolean);
  if (nodes.some((n) => n.type === "city")) { alert("the city hub can't be merged"); return; }
  $("mergeSummary").textContent =
    `combine ${ids.length} nodes into one — edges are unioned and deduplicated, ` +
    `details are concatenated with source attribution, and the most informative label is kept.`;
  const box = $("mergeList");
  box.innerHTML = "";
  for (const n of nodes) {
    const d = document.createElement("div");
    d.textContent = n.label;
    box.appendChild(d);
  }
  $("mergeModal").hidden = false;
};
$("mergeCancel").onclick = () => { $("mergeModal").hidden = true; };
$("mergeConfirm").onclick = async () => {
  $("mergeModal").hidden = true;
  const btn = $("mergeConfirm");
  btn.disabled = true;
  try {
    const r = await api("/api/graph/merge-nodes", {
      method: "POST",
      body: JSON.stringify({
        nodes: S.recon.nodes, edges: S.recon.edges, ids: [...S.multi],
        city: S.recon.city, country: S.recon.country || null,
      }),
    });
    S.recon.nodes = r.nodes; S.recon.edges = r.edges;
    resyncFromDoc(); clearMulti(); markDirty();
    selectNode(r.merged.id); centerOn(r.merged.id);
  } catch (e) {
    alert("merge failed: " + e.message);
  } finally {
    btn.disabled = false;
  }
};

// ---------------- groups from selection ----------------

$("btnGroup").onclick = () => {
  if (S.multi.size < 2) return;
  const ids = [...S.multi];
  if (ids.some((id) => S.sim.get(id)?.type === "city")) { alert("the city hub can't go in a group"); return; }
  $("groupName").value = "";
  $("groupName").placeholder = `group name — e.g. group ${S.groups.length + 1}`;
  $("groupModal").hidden = false;
  $("groupName").focus();
};
$("groupCancel").onclick = () => { $("groupModal").hidden = true; };
$("groupCreate").onclick = () => {
  const name = $("groupName").value.trim() || `group ${S.groups.length + 1}`;
  const ids = [...S.multi];
  S.groups.push({
    id: "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.slice(0, 80),
    members: ids,
    collapsed: false,
  });
  $("groupModal").hidden = true;
  clearMulti(); markDirty(); renderGroups(); applyFilters();
};
$("btnClearSel").onclick = clearMulti;

// ---------------- case files ----------------

function caseSnapshot() {
  const r = S.recon;
  return {
    city: r.city, country: r.country || null, country_code: r.country_code || null,
    lat: r.lat ?? null, lon: r.lon ?? null, cityId: r.cityId || "",
    facts: r.facts || {}, sources: r.sources || [],
    nodes: r.nodes, edges: r.edges, groups: S.groups,
  };
}

async function refreshCaseList() {
  const box = $("caseList");
  try {
    const { cases } = await api("/api/cases");
    box.innerHTML = "";
    if (!cases.length) { box.innerHTML = '<div class="empty">no case files yet</div>'; return; }
    for (const c of cases) {
      const row = document.createElement("div"); row.className = "caserow";
      const nm = document.createElement("div"); nm.className = "ct";
      const t = document.createElement("span"); t.textContent = c.name;
      const meta = document.createElement("div"); meta.className = "m";
      meta.textContent = `${c.city || ""} · ${c.nodes} nodes · ${c.edges} edges · ${c.groups} groups · ${new Date(c.updated_at).toLocaleDateString()}`;
      nm.append(t, meta);
      const acts = document.createElement("div"); acts.className = "cacts";
      const bO = document.createElement("button"); bO.textContent = "open";
      bO.onclick = () => openCase(c.id, c.name);
      const bM = document.createElement("button"); bM.textContent = "merge";
      bM.title = "merge this case into the current graph";
      bM.onclick = () => mergeCase(c.id, c.name);
      const bD = document.createElement("button"); bD.textContent = "×"; bD.className = "x";
      bD.title = "delete case";
      bD.onclick = async () => {
        if (!confirm(`delete case "${c.name}"?`)) return;
        await api(`/api/cases/${c.id}`, { method: "DELETE" });
        refreshCaseList();
      };
      acts.append(bO, bM, bD);
      row.append(nm, acts);
      box.appendChild(row);
    }
  } catch {
    box.innerHTML = '<div class="empty">couldn\'t reach the server</div>';
  }
}

async function openCases() {
  $("casesModal").hidden = false;
  $("caseSave").disabled = !S.recon;
  await refreshCaseList();
}
$("btnCases").onclick = openCases;
$("casesClose").onclick = () => { $("casesModal").hidden = true; };

$("caseSave").onclick = async () => {
  if (!S.recon) return;
  const name = $("caseName").value.trim();
  if (!name) { $("caseName").focus(); return; }
  const btn = $("caseSave");
  btn.disabled = true; btn.textContent = "saving…";
  try {
    const { id } = await api("/api/cases", {
      method: "POST", body: JSON.stringify({ name, snapshot: caseSnapshot() }),
    });
    S.docKind = "case"; S.caseId = id; S.caseName = name; S.dirty = false;
    $("caseName").value = "";
    renderTitle(); refreshCaseList();
  } catch (e) {
    alert("save failed: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "save current graph";
  }
};

async function openCase(id, name) {
  if (S.dirty && !confirm("discard unsaved changes?")) return;
  try {
    const { case: c } = await api(`/api/cases/${id}`);
    $("casesModal").hidden = true;
    stopPoll();
    S.recon = {
      id: "case:" + c.id, city: c.city || "", country: c.country || null,
      country_code: c.country_code || null, lat: c.lat ?? null, lon: c.lon ?? null,
      cityId: c.cityId || "", facts: c.facts || {}, sources: c.sources || [],
      nodes: c.nodes || [], edges: c.edges || [], status: "ready", created_at: c.created_at,
    };
    S.groups = Array.isArray(c.groups) ? c.groups : [];
    S.docKind = "case"; S.caseId = c.id; S.caseName = c.name; S.dirty = false;
    S.sim.clear(); S.edges = []; S.selected = null; S.multi.clear();
    S.view = { x: 0, y: 0, k: 1 };
    S.typeFilter = new Set(ALL_TYPES);
    selectNode(null); syncGraph(); renderTitle(); renderGroups(); updateSelBar();
    renderDossier(S.recon.facts || {}, (S.recon.nodes || []).find((n) => n.type === "city"));
    setTimeout(fit, 400);
  } catch (e) {
    alert("open failed: " + e.message);
  }
}

// Merge a saved case into the working graph. Conflict rule: nodes dedupe by
// id, existing fields win on conflict, the incoming case only fills empty
// fields (details concatenate), edges dedupe by endpoints+label. New nodes
// land on the golden-angle spiral via syncGraph.
async function mergeCase(id, name) {
  if (!S.recon) { alert("load a recon or open a case first"); return; }
  if (!confirm(`merge case "${name}" into the current graph? nodes dedupe by id; existing fields win.`)) return;
  try {
    const { case: c } = await api(`/api/cases/${id}`);
    const r = await api("/api/graph/merge", {
      method: "POST",
      body: JSON.stringify({
        nodes: S.recon.nodes, edges: S.recon.edges,
        add: { nodes: c.nodes || [], edges: c.edges || [] },
        city: S.recon.city, country: S.recon.country || null,
      }),
    });
    S.recon.nodes = r.nodes; S.recon.edges = r.edges;
    resyncFromDoc(); markDirty();
  } catch (e) {
    alert("merge failed: " + e.message);
  }
}

// ---------------- top actions ----------------

$("btnFit").onclick = fit;
$("btnPause").onclick = (e) => {
  S.running = !S.running;
  e.target.textContent = S.running ? "pause" : "resume";
  kick();
};
$("btnExport").onclick = () => {
  if (S.recon) window.location.href = `/api/recon/${S.recon.id}/export`;
};
$("btnCsv").onclick = () => {
  if (!S.recon) return;
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["id", "label", "type", "subtype", "source", "detail", "url", "lat", "lon"]];
  for (const n of S.recon.nodes) rows.push([n.id, n.label, n.type, n.subtype || "", n.source, n.detail || "", n.url || "", n.lat ?? "", n.lon ?? ""].map(q));
  const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `meridian-${S.recon.city.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

// note modal
$("btnNote").onclick = () => {
  if (!S.recon) { alert("launch a recon first"); return; }
  $("noteLabel").value = ""; $("noteBody").value = "";
  $("noteModal").hidden = false;
  $("noteLabel").focus();
};
$("noteCancel").onclick = () => { $("noteModal").hidden = true; };
$("noteSave").onclick = async () => {
  const label = $("noteLabel").value.trim();
  if (!label) { $("noteLabel").focus(); return; }
  const body = $("noteBody").value;
  if (S.docKind === "case") {
    // case views keep notes in the working document until saved
    const nid = `note:${Date.now().toString(36)}`;
    const target = S.recon.nodes.some((n) => n.id === S.selected) ? S.selected : S.recon.nodes[0]?.id;
    S.recon.nodes.push({ id: nid, label, type: "note", source: "analyst", detail: body.slice(0, 2000) });
    if (target) S.recon.edges.push({ from: nid, to: target, label: "annotates" });
    try {
      const r = await api("/api/graph/interlink", {
        method: "POST",
        body: JSON.stringify({ nodes: S.recon.nodes, edges: S.recon.edges, city: S.recon.city, country: S.recon.country || null }),
      });
      S.recon.edges = r.edges;
    } catch (e) { /* keyword edges are best-effort */ }
    resyncFromDoc(); markDirty(); selectNode(nid);
  } else {
    await api(`/api/recon/${S.recon.id}/notes`, {
      method: "POST",
      body: JSON.stringify({ label, body, link_to: S.selected }),
    });
    loadRecon(S.recon.id);
  }
  $("noteModal").hidden = true;
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("noteModal").hidden = true; $("keysModal").hidden = true;
    $("casesModal").hidden = true; $("mergeModal").hidden = true; $("groupModal").hidden = true;
    $("searchResults").hidden = true;
    if (S.multi.size) clearMulti();
  }
});

// ---------------- keys modal ----------------

function keyMsg(row, text, cls) {
  const m = row.querySelector(".keymsg");
  m.textContent = text;
  m.className = "keymsg" + (cls ? " " + cls : "");
}

function renderKeyList(keys) {
  const box = $("keyList");
  box.innerHTML = "";
  for (const k of keys) {
    const row = document.createElement("div");
    row.className = "keyrow";
    const state = k.via === "env" ? "collecting" : k.configured ? "ready" : "failed";
    const stateText = k.via === "env" ? "via env" : k.configured ? "configured" : "missing";
    row.innerHTML =
      `<div class="keyhead"><span class="keyname"></span><span class="ktag"></span>` +
      `<span class="pill ${state}">${stateText}</span></div>` +
      `<div class="keybenefit"></div>` +
      `<div class="keyrow2"><a class="keysignup" target="_blank" rel="noopener"></a><span class="keymasked"></span></div>` +
      `<div class="keyinput"><input type="password" placeholder="paste key…" autocomplete="off" spellcheck="false" aria-label="api key">` +
      `<button class="save">save</button><button class="test">test</button><button class="clear">clear</button></div>` +
      `<div class="keymsg"></div>`;
    row.querySelector(".keyname").textContent = k.name;
    row.querySelector(".ktag").textContent = k.required ? "required" : "optional";
    row.querySelector(".keybenefit").textContent = k.benefit;
    const a = row.querySelector(".keysignup");
    a.href = k.signup; a.textContent = "get a key → " + k.signupLabel;
    row.querySelector(".keymasked").textContent = k.via === "env"
      ? "set in the environment — env wins"
      : (k.masked ? "stored as " + k.masked : "no key saved");
    const input = row.querySelector("input");
    row.querySelector(".save").onclick = async () => {
      const v = input.value.trim();
      if (!v) { keyMsg(row, "paste a key first", "err"); return; }
      keyMsg(row, "saving…");
      try {
        const { keys: fresh } = await api("/api/keys", {
          method: "POST", body: JSON.stringify({ key: k.id, value: v }),
        });
        renderKeyList(fresh);
      } catch (e) { keyMsg(row, "save failed: " + e.message, "err"); }
    };
    row.querySelector(".test").onclick = async () => {
      keyMsg(row, "testing…");
      try {
        const r = await api("/api/keys/test", {
          method: "POST", body: JSON.stringify({ key: k.id }),
        });
        keyMsg(row, r.ok ? "live — " + (r.detail || "key works") : "test failed: " + (r.error || "rejected"), r.ok ? "ok" : "err");
      } catch (e) { keyMsg(row, "test failed: " + e.message, "err"); }
    };
    const clearBtn = row.querySelector(".clear");
    if (k.via === "stored") {
      clearBtn.onclick = async () => {
        try {
          const { keys: fresh } = await api("/api/keys/" + encodeURIComponent(k.id), { method: "DELETE" });
          renderKeyList(fresh);
        } catch (e) { keyMsg(row, "clear failed: " + e.message, "err"); }
      };
    } else {
      clearBtn.disabled = true;
      clearBtn.title = k.via === "env" ? "key comes from the environment — unset it there" : "nothing stored";
    }
    box.appendChild(row);
  }
}

async function openKeys() {
  $("keysModal").hidden = false;
  try {
    const { keys } = await api("/api/keys");
    renderKeyList(keys);
  } catch {
    $("keyList").innerHTML = `<div class="empty">couldn't reach the server</div>`;
  }
}
$("btnKeys").onclick = openKeys;
$("keysClose").onclick = () => { $("keysModal").hidden = true; };

// new recon form
function renderSourceChecks() {
  const box = $("sourceChecks");
  const defs = [
    ["geocode", "geocode"], ["overpass", "places"], ["wikipedia", "profile"],
    ["business", "companies"], ["people", "people"], ["music", "music"],
    ["news", "news"], ["country", "country"], ["moneytime", "money+time"], ["weather", "weather"],
    ["gdelt", "events"], ["gleif", "legal entities"], ["opensky", "aircraft"], ["openalex", "research"],
    ["gdacs", "disasters"], ["chronicling", "historic press"],
    ["icij", "offshore leaks"], ["occrp", "investigations"], ["urlscan", "web scans"],
    ["nonprofits", "nonprofits"], ["openfec", "campaign finance"],
    ["ipquery", "IP intel"], ["fdic", "banks"], ["arquivo", "web archive"], ["wigle", "wireless"],
    ["internetdb", "IP ports/vulns"], ["adsblol", "live aircraft"], ["eonet", "natural events"],
    ["usgs", "earthquakes"], ["hackertarget", "infra recon"], ["mnemonic", "passive DNS"],
    ["certspotter", "cert transparency"], ["brasilapi", "brazil data"],
    ["gleifname", "entity search"], ["secedgar", "SEC filers"], ["wikidataorg", "organizations"],
  ];
  for (const [key, label] of defs) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" checked ${key === "geocode" ? "disabled" : ""} value="${key}"><span></span>`;
    l.querySelector("span").textContent = label;
    box.appendChild(l);
  }
}
$("btnLaunch").onclick = async () => {
  const city = $("cityInput").value.trim();
  if (!city) { $("cityInput").focus(); return; }
  const sources = [...document.querySelectorAll("#sourceChecks input:checked")].map((i) => i.value);
  const btn = $("btnLaunch");
  btn.disabled = true; btn.textContent = "launching…";
  try {
    const { id } = await api("/api/recon", { method: "POST", body: JSON.stringify({ city, sources }) });
    $("cityInput").value = "";
    await loadRecon(id, true);
  } catch (e) {
    alert("launch failed: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "launch recon";
  }
};
$("cityInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnLaunch").click(); });

// ---------------- boot ----------------

function boot() {
  resize();
  renderSourceChecks();
  renderChips();
  loadList().then(() => {
    // auto-open the latest recon if any
    return api("/api/recon").then(({ recons }) => {
      if (recons && recons[0]) loadRecon(recons[0].id, true);
    }).catch(() => {});
  });
  draw(); // initial paint; the loop wakes on data via kick()
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

// test seam
window.__meridian = { S, COLORS, syncGraph, tick, draw, applyFilters, searchNodes, hitNode, hitGroup, centerOn, fit, w2s, s2w, selectNode, radiusFor, wake, kick, loop, truncLabel, renderKeyList, openKeys, groupBoxes, toggleMulti, clearMulti, updateSelBar, markDirty, renderTitle, resyncFromDoc, renderGroups, renderGroupDetail, refreshCaseList, openCase, mergeCase, caseSnapshot, marqueeSelect };

})();
