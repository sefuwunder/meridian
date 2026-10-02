// meridian — Maltego-style link analysis. Canvas entity graph + transforms.
// Zero dependencies.
(function () {
"use strict";

/* ================= state ================= */
const S = {
  view: "list",            // "list" | "graph"
  inv: null,               // open investigation {id,name,entities,links,...}
  invList: [],
  types: {},               // entity type metadata from server
  transforms: [],          // transform registry from server
  sim: new Map(),          // id -> sim node {x,y,vx,vy,r,...entity}
  edges: [],
  selected: null,
  typeFilter: new Set(),
  running: true,
  alpha: 1,
  dragging: null,
  panning: null,
  cam: { x: 0, y: 0, k: 1 },
  transformBusy: false,
  searchTimer: null,
};

const $ = (id) => document.getElementById(id);
const canvas = $("graph"), ctx = canvas.getContext("2d");

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function truncLabel(s) {
  s = String(s || "");
  return s.length > 34 ? s.slice(0, 33) + "…" : s;
}
async function api(path, opts) {
  const r = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts && opts.headers) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function typeColor(t) { return (S.types[t] && S.types[t].color) || "#95A5A6"; }
function typeIcon(t) { return (S.types[t] && S.types[t].icon) || "•"; }
function typeLabel(t) { return (S.types[t] && S.types[t].label) || t; }

/* ================= canvas engine ================= */

function radiusFor(degree) {
  return 22 + Math.min(14, (degree || 0) * 1.6);
}

function syncGraph() {
  if (!S.inv) return;
  const degree = {};
  for (const e of S.inv.links) {
    degree[e.from] = (degree[e.from] || 0) + 1;
    degree[e.to] = (degree[e.to] || 0) + 1;
  }
  let added = 0;
  for (const n of S.inv.entities) {
    if (S.sim.has(n.id)) {
      const s = S.sim.get(n.id);
      Object.assign(s, { label: n.label, type: n.type, properties: n.properties, source: n.source, url: n.url });
      s.r = radiusFor(degree[n.id]);
      continue;
    }
    const idx = S.sim.size, ga = Math.PI * (3 - Math.sqrt(5));
    const a = idx * ga, d = 60 + Math.sqrt(idx) * 30;
    S.sim.set(n.id, {
      ...n, x: Math.cos(a) * d, y: Math.sin(a) * d,
      vx: 0, vy: 0, r: radiusFor(degree[n.id]), hidden: false,
    });
    added++;
  }
  const ekey = (e) => e.from + ">" + e.to + ":" + e.label;
  const have = new Set(S.edges.map(ekey));
  for (const e of S.inv.links) {
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
function visibleEdges() { return S.edges.filter((e) => !e.hidden); }

function applyFilters() {
  for (const n of S.sim.values()) {
    n.hidden = S.typeFilter.size > 0 && !S.typeFilter.has(n.type);
  }
  const hiddenIds = new Set();
  for (const n of S.sim.values()) if (n.hidden) hiddenIds.add(n.id);
  for (const e of S.edges) e.hidden = hiddenIds.has(e.from) || hiddenIds.has(e.to);
  if (S.selected && S.sim.get(S.selected)?.hidden) { S.selected = null; renderDetail(); }
  updateCounts();
  draw();
}

/* ---- physics: repulsion via spatial hash, springs on edges ---- */
function tick() {
  const nodes = visibleNodes(), edges = visibleEdges();
  const n = nodes.length;
  if (!n) return;
  const alpha = S.dragging ? 0.35 : S.alpha;
  const cell = 90, grid = new Map();
  for (const nd of nodes) {
    const gx = Math.floor(nd.x / cell), gy = Math.floor(nd.y / cell);
    const k = gx + "," + gy;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(nd);
  }
  for (const nd of nodes) {
    if (nd === S.dragging) continue;
    const gx = Math.floor(nd.x / cell), gy = Math.floor(nd.y / cell);
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
      const bucket = grid.get(ix + "," + iy);
      if (!bucket) continue;
      for (const o of bucket) {
        if (o === nd) continue;
        let dx = nd.x - o.x, dy = nd.y - o.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 160 * 160 || d2 < 0.01) continue;
        const d = Math.sqrt(d2), f = 5200 / d2;
        dx /= d; dy /= d;
        nd.vx += dx * f * alpha; nd.vy += dy * f * alpha;
      }
    }
  }
  for (const e of edges) {
    const a = S.sim.get(e.from), b = S.sim.get(e.to);
    if (!a || !b || a.hidden || b.hidden) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
    const rest = 150, f = (d - rest) * 0.02 * alpha;
    const ux = dx / d, uy = dy / d;
    if (a !== S.dragging) { a.vx += ux * f; a.vy += uy * f; }
    if (b !== S.dragging) { b.vx -= ux * f; b.vy -= uy * f; }
  }
  for (const nd of nodes) {
    if (nd === S.dragging) continue;
    nd.vx *= 0.86; nd.vy *= 0.86;
    nd.vx += (0 - nd.x) * 0.004 * alpha;
    nd.vy += (0 - nd.y) * 0.004 * alpha;
    nd.x += nd.vx; nd.y += nd.vy;
  }
  S.alpha *= 0.985;
  if (S.alpha < 0.01) S.alpha = 0;
}

let rafId = 0;
function loop() {
  rafId = 0;
  if (S.running && S.alpha > 0.005) { tick(); draw(); rafId = requestAnimationFrame(loop); }
  else if (S.running) { draw(); }
}
function kick() { if (!rafId && S.running) rafId = requestAnimationFrame(loop); }
function wake() { S.alpha = Math.max(S.alpha, 0.6); kick(); }

/* ---- draw ---- */
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, r.width * dpr);
  canvas.height = Math.max(1, r.height * dpr);
  canvas.style.width = r.width + "px";
  canvas.style.height = r.height + "px";
  draw();
}
function w2s(x, y) { return [(x - S.cam.x) * S.cam.k + canvas.width / 2, (y - S.cam.y) * S.cam.k + canvas.height / 2]; }
function s2w(px, py) {
  const r = canvas.getBoundingClientRect();
  return [((px - r.left) * (canvas.width / r.width) - canvas.width / 2) / S.cam.k + S.cam.x,
          ((py - r.top) * (canvas.height / r.height) - canvas.height / 2) / S.cam.k + S.cam.y];
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

function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  // edges
  for (const e of visibleEdges()) {
    const a = S.sim.get(e.from), b = S.sim.get(e.to);
    if (!a || !b) continue;
    const [ax, ay] = w2s(a.x, a.y), [bx, by] = w2s(b.x, b.y);
    const sel = S.selected && (e.from === S.selected || e.to === S.selected);
    ctx.strokeStyle = sel ? "rgba(232,168,56,.75)" : "rgba(140,160,180,.28)";
    ctx.lineWidth = sel ? 2 : 1.2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    if (S.cam.k > 0.45 && e.label) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      ctx.font = "10px system-ui";
      const w = ctx.measureText(e.label).width;
      ctx.fillStyle = "rgba(20,26,34,.85)";
      ctx.fillRect(mx - w / 2 - 3, my - 8, w + 6, 14);
      ctx.fillStyle = sel ? "#E8A838" : "rgba(190,205,220,.75)";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(e.label, mx, my);
    }
  }
  // nodes
  for (const n of visibleNodes()) {
    const [x, y] = w2s(n.x, n.y);
    const r = n.r * S.cam.k;
    const color = typeColor(n.type);
    const sel = S.selected === n.id;
    // glow for selection
    if (sel) {
      ctx.beginPath(); ctx.arc(x, y, r + 7, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
    }
    // body
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#1b2430";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    // icon
    ctx.font = Math.max(10, r * 0.85) + "px system-ui";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(typeIcon(n.type), x, y - r * 0.18);
    // label
    ctx.font = "600 " + Math.max(9, Math.min(13, r * 0.42)) + "px system-ui";
    const label = truncLabel(n.label);
    const lw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(16,22,30,.88)";
    roundRectPath(ctx, x - lw / 2 - 5, y + r * 0.32, lw + 10, 17, 8);
    ctx.fill();
    ctx.fillStyle = sel ? "#fff" : "rgba(230,238,246,.92)";
    ctx.fillText(label, x, y + r * 0.32 + 9);
  }
}

/* ================= interactions ================= */
function hitNode(px, py) {
  const [wx, wy] = s2w(px, py);
  let best = null, bestD = 1e9;
  for (const n of visibleNodes()) {
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d < n.r + 6 && d < bestD) { best = n; bestD = d; }
  }
  return best;
}
function centerOn(id) {
  const n = S.sim.get(id);
  if (!n) return;
  S.cam.x = n.x; S.cam.y = n.y; S.cam.k = Math.max(S.cam.k, 1);
  draw();
}
function fit() {
  const nodes = visibleNodes();
  if (!nodes.length) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
  }
  const W = canvas.width, H = canvas.height;
  const k = Math.min(2.2, Math.max(0.15, Math.min(W / (x1 - x0 + 120), H / (y1 - y0 + 120))));
  S.cam.k = k;
  S.cam.x = (x0 + x1) / 2; S.cam.y = (y0 + y1) / 2;
  draw();
}

canvas.addEventListener("pointerdown", (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  const n = hitNode(ev.clientX, ev.clientY);
  if (n) {
    S.dragging = n;
    S.dragMoved = false;
    const [wx, wy] = s2w(ev.clientX, ev.clientY);
    n._dx = n.x - wx; n._dy = n.y - wy;
  } else {
    S.panning = { sx: ev.clientX, sy: ev.clientY, cx: S.cam.x, cy: S.cam.y };
  }
});
canvas.addEventListener("pointermove", (ev) => {
  if (S.dragging) {
    const [wx, wy] = s2w(ev.clientX, ev.clientY);
    const n = S.dragging;
    if (Math.hypot(wx + n._dx - n.x, wy + n._dy - n.y) > 3) S.dragMoved = true;
    n.x = wx + n._dx; n.y = wy + n._dy;
    n.vx = n.vy = 0;
    wake(); draw();
  } else if (S.panning) {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width, sy = canvas.height / r.height;
    S.cam.x = S.panning.cx - (ev.clientX - S.panning.sx) * sx / S.cam.k;
    S.cam.y = S.panning.cy - (ev.clientY - S.panning.sy) * sy / S.cam.k;
    draw();
  }
});
canvas.addEventListener("pointerup", (ev) => {
  if (S.dragging) {
    const n = S.dragging;
    S.dragging = null;
    if (!S.dragMoved) selectNode(n.id);
    draw();
  }
  S.panning = null;
});
canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const [wx, wy] = s2w(ev.clientX, ev.clientY);
  const k2 = Math.min(3, Math.max(0.12, S.cam.k * (ev.deltaY < 0 ? 1.12 : 0.89)));
  S.cam.x = wx - (wx - S.cam.x) * (S.cam.k / k2);
  S.cam.y = wy - (wy - S.cam.y) * (S.cam.k / k2);
  S.cam.k = k2;
  draw();
}, { passive: false });

function selectNode(id) {
  S.selected = id;
  renderDetail();
  draw();
}

/* ================= views ================= */
function showView(v) {
  S.view = v;
  document.querySelector("aside.left").style.display = v === "graph" ? "" : "";
  document.querySelector("main.stage").style.display = v === "graph" ? "" : "none";
  document.querySelector("aside.right").style.display = v === "graph" ? "" : "none";
  document.querySelector("aside.left").style.display = v === "graph" ? "" : "none";
  if (v === "graph") { resize(); }
}

async function loadInvList() {
  try {
    const j = await api("/api/investigations");
    S.invList = j.investigations || [];
  } catch { S.invList = []; }
  const ul = $("invList");
  if (!S.invList.length) {
    ul.innerHTML = '<div class="empty">no investigations yet — open one above</div>';
    return;
  }
  ul.innerHTML = S.invList.map((i) =>
    `<li class="inv-item${S.inv && S.inv.id === i.id ? " active" : ""}" data-id="${escapeHtml(i.id)}">` +
    `<span class="inv-name">${escapeHtml(i.name)}</span>` +
    `<span class="inv-meta">${i.entities} entities · ${i.links} links</span>` +
    `<button class="inv-del" data-del="${escapeHtml(i.id)}" title="delete">×</button></li>`
  ).join("");
  ul.querySelectorAll(".inv-item").forEach((li) => {
    li.addEventListener("click", (ev) => {
      if (ev.target.dataset.del) return;
      openInvestigation(li.dataset.id);
    });
  });
  ul.querySelectorAll("[data-del]").forEach((b) => {
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("delete this investigation?")) return;
      await api("/api/investigations/" + b.dataset.del, { method: "DELETE" });
      if (S.inv && S.inv.id === b.dataset.del) { S.inv = null; S.sim.clear(); S.edges = []; }
      loadInvList();
    });
  });
}

async function openInvestigation(id) {
  const j = await api("/api/investigations/" + id);
  S.inv = j.investigation;
  S.sim.clear(); S.edges = [];
  S.selected = null;
  S.cam = { x: 0, y: 0, k: 1 };
  $("invTitle").textContent = S.inv.name;
  showView("graph");
  syncGraph();
  renderChips();
  renderDetail();
  loadInvList();
  setTimeout(fit, 60);
}

function updateCounts() {
  const n = visibleNodes().length, e = visibleEdges().length;
  $("graphCounts").textContent = S.inv ? `${n} entities · ${e} links` : "";
}

function renderChips() {
  const present = new Set();
  for (const n of S.sim.values()) present.add(n.type);
  const chips = [...present].sort();
  $("typeChips").innerHTML = chips.map((t) =>
    `<button class="chip${S.typeFilter.has(t) ? " on" : ""}" data-t="${t}" ` +
    `style="--c:${typeColor(t)}">${typeIcon(t)} ${escapeHtml(typeLabel(t))}</button>`
  ).join("");
  $("typeChips").querySelectorAll(".chip").forEach((c) => {
    c.addEventListener("click", () => {
      const t = c.dataset.t;
      if (S.typeFilter.has(t)) S.typeFilter.delete(t); else S.typeFilter.add(t);
      renderChips(); applyFilters();
    });
  });
}

/* ================= entity detail + transforms ================= */
function transformsForEntity(type) {
  return S.transforms.filter((t) => t.inputTypes.includes(type));
}

function renderDetail() {
  const el = $("entityDetail"), tp = $("transformPanel"), tl = $("transformList");
  const n = S.selected ? S.sim.get(S.selected) : null;
  if (!n) {
    el.innerHTML = '<div class="empty">click any entity in the graph</div>';
    tp.hidden = true;
    return;
  }
  const props = n.properties || {};
  const propRows = Object.entries(props).map(([k, v]) =>
    `<div class="prop"><span class="pk">${escapeHtml(k)}</span><span class="pv">${escapeHtml(v)}</span></div>`
  ).join("");
  const degree = S.edges.filter((e) => e.from === n.id || e.to === n.id).length;
  el.innerHTML =
    `<div class="ent-head" style="--c:${typeColor(n.type)}">` +
    `<span class="ent-icon">${typeIcon(n.type)}</span>` +
    `<div><div class="ent-label">${escapeHtml(n.label)}</div>` +
    `<div class="ent-type">${escapeHtml(typeLabel(n.type))} · ${degree} link${degree === 1 ? "" : "s"}</div></div></div>` +
    `<div class="prop"><span class="pk">value</span><span class="pv mono">${escapeHtml(n.value)}</span></div>` +
    `<div class="prop"><span class="pk">source</span><span class="pv">${escapeHtml(n.source || "")}</span></div>` +
    propRows +
    (n.url ? `<div class="prop"><span class="pk">link</span><span class="pv"><a href="${escapeHtml(n.url)}" target="_blank" rel="noopener">open ↗</a></span></div>` : "");
  const ts = transformsForEntity(n.type);
  tp.hidden = false;
  tl.innerHTML = ts.length ? ts.map((t) =>
    `<button class="tbtn" data-t="${escapeHtml(t.key)}" ${S.transformBusy ? "disabled" : ""}>` +
    `<span class="tname">${escapeHtml(t.label)}${t.needsKey ? " 🔑" : ""}</span>` +
    `<span class="tdesc">${escapeHtml(t.description)}</span></button>`
  ).join("") : '<div class="empty">no transforms for this entity type yet</div>';
  tl.querySelectorAll(".tbtn").forEach((b) => {
    b.addEventListener("click", () => runTransform(n.id, b.dataset.t));
  });
}

function toast(msg, ms) {
  const t = $("transformToast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, ms || 4000);
}

async function runTransform(entityId, key) {
  if (!S.inv || S.transformBusy) return;
  S.transformBusy = true;
  renderDetail();
  toast("running transform…");
  try {
    const j = await api(`/api/investigations/${S.inv.id}/transform`, {
      method: "POST", body: JSON.stringify({ entityId, transformKey: key }),
    });
    S.inv = j.investigation;
    syncGraph();
    renderDetail();
    toast(`${j.note} · +${j.addedEntities} entities`, 5000);
  } catch (e) {
    toast("transform failed: " + e.message, 6000);
  }
  S.transformBusy = false;
  renderDetail();
}

/* ================= Maltego Search ================= */
function setupSearch() {
  const input = $("searchInput"), box = $("searchResults");
  input.addEventListener("input", () => {
    clearTimeout(S.searchTimer);
    const q = input.value.trim();
    if (q.length < 2) { box.hidden = true; return; }
    S.searchTimer = setTimeout(async () => {
      try {
        const j = await api("/api/search", { method: "POST", body: JSON.stringify({ query: q }) });
        if (!j.entities.length) { box.hidden = true; return; }
        box.innerHTML = `<div class="sr-head">detected: ${escapeHtml(typeLabel(j.type))} — click to add</div>` +
          j.entities.map((e) =>
            `<button class="sr-item" data-id="${escapeHtml(e.id)}" data-type="${escapeHtml(e.type)}" data-value="${escapeHtml(e.value)}">` +
            `<span class="sr-icon" style="color:${typeColor(e.type)}">${typeIcon(e.type)}</span>` +
            `<span class="sr-label">${escapeHtml(e.label)}</span>` +
            `<span class="sr-type">${escapeHtml(typeLabel(e.type))}</span></button>`
          ).join("");
        box.hidden = false;
        box.querySelectorAll(".sr-item").forEach((b) => {
          b.addEventListener("click", () => addEntityToGraph(b.dataset.type, b.dataset.value, b.dataset.id));
        });
      } catch { box.hidden = true; }
    }, 350);
  });
  input.addEventListener("keydown", (ev) => { if (ev.key === "Escape") box.hidden = true; });
  document.addEventListener("click", (ev) => {
    if (!box.contains(ev.target) && ev.target !== input) box.hidden = true;
  });
}

async function addEntityToGraph(type, value, knownId) {
  if (!S.inv) { toast("open an investigation first", 3000); return; }
  $("searchResults").hidden = true;
  $("searchInput").value = "";
  try {
    const j = await api(`/api/investigations/${S.inv.id}/entities`, {
      method: "POST", body: JSON.stringify({ type, value }),
    });
    S.inv = j.investigation;
    syncGraph();
    renderDetail();
    if (knownId && S.sim.has(knownId)) { selectNode(knownId); centerOn(knownId); }
  } catch (e) { toast("couldn't add entity: " + e.message, 5000); }
}

/* ================= modals ================= */
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }

function fillTypeSelect(sel, includeAuto) {
  sel.innerHTML = (includeAuto ? '<option value="">auto-detect</option>' : "") +
    Object.entries(S.types).map(([k, m]) => `<option value="${k}">${m.icon} ${escapeHtml(m.label)}</option>`).join("");
}

async function setupModals() {
  fillTypeSelect($("seedType"), true);
  fillTypeSelect($("entityTypeSel"), false);

  $("btnNewInv").addEventListener("click", async () => {
    const name = $("invName").value.trim() || "untitled";
    const seed = $("seedInput").value.trim();
    if (!seed) { toast("enter a seed entity first", 3000); return; }
    try {
      const j = await api("/api/investigations", {
        method: "POST",
        body: JSON.stringify({ name, seedValue: seed, seedType: $("seedType").value || undefined }),
      });
      $("invName").value = ""; $("seedInput").value = "";
      openInvestigation(j.investigation.id);
    } catch (e) { toast("couldn't open investigation: " + e.message, 5000); }
  });
  $("seedInput").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("btnNewInv").click(); });

  $("btnAddEntity").addEventListener("click", () => {
    if (!S.inv) { toast("open an investigation first", 3000); return; }
    openModal("entityModal");
    setTimeout(() => $("entityValue").focus(), 50);
  });
  $("entityCancel").addEventListener("click", () => closeModal("entityModal"));
  $("entitySave").addEventListener("click", async () => {
    const v = $("entityValue").value.trim();
    if (!v) return;
    closeModal("entityModal");
    $("entityValue").value = "";
    await addEntityToGraph($("entityTypeSel").value, v, null);
  });

  $("btnNote").addEventListener("click", () => {
    if (!S.inv) { toast("open an investigation first", 3000); return; }
    openModal("noteModal");
    setTimeout(() => $("noteBody").focus(), 50);
  });
  $("noteCancel").addEventListener("click", () => closeModal("noteModal"));
  $("noteSave").addEventListener("click", async () => {
    const text = $("noteBody").value.trim();
    if (!text) return;
    closeModal("noteModal");
    $("noteBody").value = "";
    try {
      const j = await api(`/api/investigations/${S.inv.id}/note`, {
        method: "POST", body: JSON.stringify({ text, entityId: S.selected }),
      });
      S.inv = j.investigation;
      syncGraph();
    } catch (e) { toast("couldn't add note: " + e.message, 5000); }
  });

  $("btnKeys").addEventListener("click", async () => {
    openModal("keysModal");
    await refreshKeys();
  });
  $("keysClose").addEventListener("click", () => closeModal("keysModal"));
}

async function refreshKeys() {
  const box = $("keyList");
  box.innerHTML = '<div class="empty">loading…</div>';
  try {
    const j = await api("/api/keys");
    box.innerHTML = (j.keys || []).map((k) =>
      `<div class="keyrow"><div><div class="keyname">${escapeHtml(k.name)}</div>` +
      `<div class="fine">${escapeHtml(k.benefit || "")}</div>` +
      (k.signup ? `<a href="${escapeHtml(k.signup)}" target="_blank" rel="noopener" class="fine">${escapeHtml(k.signupLabel || k.signup)}</a>` : "") +
      `</div><div class="keyctl"><span class="mono">${escapeHtml(k.masked || "not set")}</span>` +
      `<input data-key="${escapeHtml(k.id)}" placeholder="paste key" autocomplete="off" type="password">` +
      `<button data-save="${escapeHtml(k.id)}">save</button>` +
      (k.masked ? `<button data-clear="${escapeHtml(k.id)}">clear</button>` : "") +
      `</div></div>`
    ).join("") || '<div class="empty">no keys defined</div>';
    box.querySelectorAll("[data-save]").forEach((b) => {
      b.addEventListener("click", async () => {
        const input = box.querySelector(`input[data-key="${b.dataset.save}"]`);
        await api("/api/keys", { method: "POST", body: JSON.stringify({ id: b.dataset.save, value: input.value }) });
        refreshKeys();
      });
    });
    box.querySelectorAll("[data-clear]").forEach((b) => {
      b.addEventListener("click", async () => {
        await api("/api/keys", { method: "POST", body: JSON.stringify({ id: b.dataset.clear, value: "" }) });
        refreshKeys();
      });
    });
  } catch { box.innerHTML = '<div class="empty">couldn\'t load keys</div>'; }
}

/* ================= topbar ================= */
function setupTopbar() {
  $("btnFit").addEventListener("click", fit);
  $("btnPause").addEventListener("click", () => {
    S.running = !S.running;
    $("btnPause").textContent = S.running ? "pause" : "resume";
    if (S.running) { S.alpha = 1; kick(); }
  });
  $("btnExport").addEventListener("click", () => {
    if (!S.inv) return;
    const blob = new Blob([JSON.stringify(S.inv, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = S.inv.name.replace(/[^a-z0-9-_]+/gi, "-") + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
}

/* ================= boot ================= */
async function boot() {
  try {
    const [t, tr] = await Promise.all([api("/api/entity-types"), api("/api/transforms")]);
    S.types = t.types || {};
    S.transforms = tr.transforms || [];
  } catch (e) {
    document.body.insertAdjacentHTML("afterbegin",
      '<div style="padding:2rem;color:#e88">couldn\'t reach the meridian server — is it running on :3005?</div>');
    return;
  }
  setupTopbar();
  setupModals();
  setupSearch();
  showView("list");
  $("invTitle").textContent = "investigations";
  await loadInvList();
  window.addEventListener("resize", () => { if (S.view === "graph") resize(); });
  // deep link: #/i/<id>
  const m = location.hash.match(/^#\/i\/([a-z0-9-]+)$/);
  if (m) { try { await openInvestigation(m[1]); } catch { /* fall through to list */ } }
}

document.addEventListener("DOMContentLoaded", boot);

// test seam (evaluated by the DOM test suite with a stubbed document)
(globalThis).__meridian = {
  S, selectNode, renderDetail, renderChips, loadInvList, refreshKeys,
  fillTypeSelect, transformsForEntity, syncGraph, applyFilters,
};
})();
