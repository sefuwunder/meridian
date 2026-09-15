// meridian — graph-analysis operations. Pure functions over node/edge/group
// arrays, shared by the server endpoints so recons and opened cases behave
// identically. Keyword-edge recomputation stays in sources.ts
// (addKeywordEdges) so the single extractor is never duplicated.

import type { GNode, GEdge } from "./sources";
import { mergeGraph } from "./sources";

export interface GGroup {
  id: string;
  name: string;
  members: string[]; // node ids, one level only — no nested groups
  collapsed: boolean;
}

export interface GMergedNode extends GNode {
  sources?: string[];   // union of contributor sources
  mergedIds?: string[]; // every absorbed node id, for provenance
}

// "Most informative" label: the longest label wins, detail richness and a
// URL break ties. Deterministic: first node wins exact ties.
function infoScore(n: GNode): number {
  return (
    (n.label || "").length * 2 +
    (n.detail || "").length +
    (n.url ? 25 : 0) +
    (n.subtype ? 8 : 0)
  );
}

export interface MergeNodesResult {
  nodes: GNode[];
  edges: GEdge[];
  merged: GMergedNode;
  absorbed: string[];
}

// Merge several nodes into one: the survivor keeps the most informative
// label, edges are unioned (deduplicated, rewritten onto the survivor,
// self-edges dropped), details are concatenated with per-contributor source
// attribution, and analyst-note bodies survive inside the merged detail.
export function mergeNodes(
  nodes: GNode[], edges: GEdge[], ids: string[]
): MergeNodesResult {
  const want = new Set(ids.map(String));
  const parts = nodes.filter((n) => want.has(n.id));
  if (parts.length < 2) throw new Error("select at least two nodes to merge");
  if (parts.some((n) => n.type === "city"))
    throw new Error("the city hub can't be merged");
  const survivor = parts.reduce((a, b) => (infoScore(b) > infoScore(a) ? b : a));
  const absorbed = parts.map((p) => p.id).filter((id) => id !== survivor.id);
  const gone = new Set(absorbed);

  const detailParts = parts
    .filter((p) => p.detail && p.detail.trim())
    .map((p) => `[${p.label} · ${p.source || "unknown source"}] ${p.detail!.trim()}`);
  const merged: GMergedNode = {
    ...survivor,
    subtype: survivor.subtype || parts.find((p) => p.subtype)?.subtype,
    url: survivor.url || parts.find((p) => p.url)?.url,
    lat: survivor.lat ?? parts.find((p) => p.lat != null)?.lat,
    lon: survivor.lon ?? parts.find((p) => p.lon != null)?.lon,
    deepSearched: parts.some((p) => p.deepSearched),
    detail: detailParts.join(" — ") || undefined,
    sources: [...new Set(parts.map((p) => p.source).filter(Boolean))],
    mergedIds: parts.map((p) => p.id),
  };

  const out: GNode[] = [];
  for (const n of nodes) {
    if (gone.has(n.id)) continue;
    out.push(n.id === survivor.id ? merged : n);
  }
  const ekey = (e: GEdge) => `${e.from}>${e.to}:${e.label}`;
  const seen = new Set<string>();
  const outEdges: GEdge[] = [];
  for (const e of edges) {
    let from = gone.has(e.from) ? survivor.id : e.from;
    let to = gone.has(e.to) ? survivor.id : e.to;
    if (from === to) continue; // self-edge created by the merge
    const k = ekey({ from, to, label: e.label });
    if (seen.has(k)) continue;
    seen.add(k);
    outEdges.push({ ...e, from, to });
  }
  return { nodes: out, edges: outEdges, merged, absorbed };
}

// ---------- groups (pure bookkeeping; rendering lives in the frontend) ----------

export function createGroup(
  groups: GGroup[], name: string, memberIds: string[], nodes: GNode[]
): GGroup[] {
  const have = new Set(nodes.map((n) => n.id));
  const clean = [...new Set(memberIds.map(String))].filter((id) => have.has(id));
  if (clean.length < 2) throw new Error("select at least two nodes for a group");
  if (nodes.some((n) => clean.includes(n.id) && n.type === "city"))
    throw new Error("the city hub can't go in a group");
  const gid = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return [
    ...groups,
    {
      id: gid,
      name: name.trim().slice(0, 80) || `group ${groups.length + 1}`,
      members: clean,
      collapsed: false,
    },
  ];
}

function findGroup(groups: GGroup[], id: string): GGroup {
  const g = groups.find((x) => x.id === id);
  if (!g) throw new Error("group not found");
  return g;
}

export function toggleGroup(groups: GGroup[], id: string): GGroup[] {
  findGroup(groups, id);
  return groups.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g));
}

export function renameGroup(groups: GGroup[], id: string, name: string): GGroup[] {
  findGroup(groups, id);
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error("group name is required");
  return groups.map((g) => (g.id === id ? { ...g, name: clean } : g));
}

// Ungroup: the container goes away, every member stays in the graph.
export function ungroup(groups: GGroup[], id: string): GGroup[] {
  findGroup(groups, id);
  return groups.filter((g) => g.id !== id);
}

// Drop group references to nodes that no longer exist (after a merge or a
// case merge); groups left empty are removed.
export function pruneGroups(groups: GGroup[], validIds: Set<string>): GGroup[] {
  return groups
    .map((g) => ({ ...g, members: g.members.filter((id) => validIds.has(id)) }))
    .filter((g) => g.members.length > 0);
}

export function groupsForNode(groups: GGroup[], nodeId: string): GGroup[] {
  return groups.filter((g) => g.members.includes(nodeId));
}

// ---------- merge a case file (or any second graph) into the working graph ----------
//
// Conflict rule (same as the collector merge path, so behavior is uniform):
// nodes dedupe by id; the EXISTING node's fields win on conflict, the
// incoming graph only fills fields that are empty; when both sides carry a
// different detail it is concatenated; urls are kept when missing. Edges
// dedupe by endpoints+label and are dropped when an endpoint doesn't exist.
export function mergeCaseInto(
  cur: { nodes: GNode[]; edges: GEdge[] },
  add: { nodes: GNode[]; edges: GEdge[] }
): { nodes: GNode[]; edges: GEdge[] } {
  return mergeGraph(cur, { nodes: add.nodes, edges: add.edges });
}
