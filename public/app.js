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
const FONT = "11px -apple-system,Segoe UI,Roboto,sans-serif";
const FONT_CITY = "700 13px -apple-system,Segoe UI,Roboto,sans-serif";
const LABEL_MAX = 24; // canvas labels truncated past this length
function truncLabel(s) {
  s = s || "";
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + "…" : s;
}

const S = {
  recon: null,
  sim: new Map(),       // id -> {id,label,type,...,x,y,vx,vy,r,hidden,pinned}
  edges: [],            // {from,to,label,hidden}
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
  for (const n of S.sim.values()) {
    const typeHidden = !S.typeFilter.has(n.type);
    const queryHidden = Boolean(q &&
      !(n.label || "").toLowerCase().includes(q) &&
      !(n.subtype || "").toLowerCase().includes(q));
    n.hidden = typeHidden || queryHidden;
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
  const nd = hitNode(px, py);
  S.moved = false;
  if (nd) {
    S.dragging = nd;
    S.dragX = px; S.dragY = py;
    kick();
  } else {
    S.panning = { x: px, y: py, vx: S.view.x, vy: S.view.y };
  }
  canvas.classList.add("dragging");
});
window.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
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
  if (wasDrag && !S.moved) selectNode(wasDrag.id);
  if (wasDrag) { S.alpha = Math.max(S.alpha, 0.4); kick(); }
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
  const nd = S.sim.get(id);
  const el = $("nodeDetail");
  if (!nd) { el.innerHTML = '<div class="empty">click any node in the web</div>'; return; }
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
      await api(`/api/recon/${S.recon.id}/deep-search`, {
        method: "POST", body: JSON.stringify({ nodeId: id }),
      });
      await loadRecon(S.recon.id); // incremental re-sync via syncGraph
      selectNode(id); // refresh the panel → "deep search again"
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
        if (S.recon && S.recon.id === rc.id) { S.recon = null; S.sim.clear(); S.edges = []; S.selected = null; $("reconTitle").textContent = "no recon loaded"; selectNode(null); }
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
      selectNode(null);
    }
    syncGraph();
    const cityNode = recon.nodes.find((n) => n.type === "city");
    $("reconTitle").textContent = `${recon.city}${recon.country ? " · " + recon.country : ""} — ${recon.status}`;
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
  await api(`/api/recon/${S.recon.id}/notes`, {
    method: "POST",
    body: JSON.stringify({ label, body: $("noteBody").value, link_to: S.selected }),
  });
  $("noteModal").hidden = true;
  loadRecon(S.recon.id);
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("noteModal").hidden = true; $("searchResults").hidden = true; }
});

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
window.__meridian = { S, COLORS, syncGraph, tick, draw, applyFilters, searchNodes, hitNode, centerOn, fit, w2s, s2w, selectNode, radiusFor, wake, kick, loop, truncLabel };

})();
