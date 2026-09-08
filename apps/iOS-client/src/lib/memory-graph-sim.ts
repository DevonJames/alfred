/**
 * Force-directed layout for the memory graph (ported from the desktop canvas).
 * Keeps the cloud round and readable on a phone viewport.
 */
import type { GraphLink, GraphNode } from "./types";

export type { GraphLink, GraphNode };

export interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface SimLink {
  source: SimNode;
  target: SimNode;
  predicate: string;
}

export interface Simulation {
  nodes: SimNode[];
  links: SimLink[];
  alpha: number;
  width: number;
  height: number;
}

/** Cap for smooth 60fps on device; high-degree hubs kept first. */
export const GRAPH_NODE_CAP = 220;

export const TYPE_COLORS: Record<string, string> = {
  Entity: "#D8A54A",
  Organization: "#6B9AC4",
  Episode: "#5AA97C",
  Assertion: "#E2574C",
  Observation: "#3DFFC4",
  Artifact: "#8D939E",
};

export function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? "#93A094";
}

export function isOrganizationNode(node: {
  type?: string;
  schemaType?: string | null;
}): boolean {
  if (String(node.type || "").trim() !== "Entity") return false;
  return String(node.schemaType || "").toLowerCase().includes("organization");
}

/** Record-type filters plus Organization (Entity subtype via schema.org). */
export function nodePassesTypeFilter(
  node: { type?: string; schemaType?: string | null },
  types: Set<string>,
): boolean {
  if (types.size === 0) return true;
  const t = String(node.type || "").trim();
  if (t === "Entity") {
    const isOrg = isOrganizationNode(node);
    if (types.has("Organization") && !types.has("Entity")) return isOrg;
    if (types.has("Organization") && types.has("Entity")) return isOrg;
    if (types.has("Entity")) return true;
    return false;
  }
  return types.has(t);
}

export function nodeRadius(node: { degree?: number }): number {
  return 4 + Math.min(12, (node.degree ?? 0) * 0.5);
}

/**
 * Prefer hubs + their one-hop neighborhood so a phone can still show the
 * shape of a large graph without melting the GPU.
 */
export function trimGraph(
  nodes: GraphNode[],
  links: GraphLink[],
  cap = GRAPH_NODE_CAP
): { nodes: GraphNode[]; links: GraphLink[] } {
  if (nodes.length <= cap) return { nodes, links };

  const ranked = [...nodes].sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
  const keep = new Set(ranked.slice(0, Math.floor(cap * 0.65)).map((n) => n.id));

  for (const l of links) {
    if (keep.has(l.source)) keep.add(l.target);
    if (keep.has(l.target)) keep.add(l.source);
    if (keep.size >= cap) break;
  }

  const trimmedNodes = nodes.filter((n) => keep.has(n.id)).slice(0, cap);
  const ids = new Set(trimmedNodes.map((n) => n.id));
  const trimmedLinks = links.filter((l) => ids.has(l.source) && ids.has(l.target));
  return { nodes: trimmedNodes, links: trimmedLinks };
}

export function nodeMatchesQuery(node: GraphNode, q: string): boolean {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) return true;
  const hay = `${node.label} ${node.searchText} ${node.type}`.toLowerCase();
  return trimmed.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

export function linkKey(source: string, target: string, predicate: string): string {
  return source < target
    ? `${source}|${target}|${predicate}`
    : `${target}|${source}|${predicate}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Token match on a label using word boundaries (avoids "james" ⊂ "Devon James" noise). */
export function labelMatchesTokens(label: string, tokens: string[]): boolean {
  const hay = label.toLowerCase();
  return tokens.every((t) => {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(t)}(?:[^a-z0-9]|$)`, "i");
    return re.test(hay);
  });
}

/**
 * Collapse Assertion hubs into Entity—Entity edges for dual-search paths.
 * Graph storage is Assertion→subject/object; semantic hops are Person↔Org.
 */
export function projectEntityLinks(
  nodes: GraphNode[],
  links: GraphLink[],
): Array<GraphLink & { viaAssertion?: string }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byAssertion = new Map<
    string,
    { subjects: string[]; objects: string[]; predicate: string }
  >();

  for (const l of links) {
    const s = byId.get(l.source);
    const t = byId.get(l.target);
    const pred = (l.predicate || "").toLowerCase();

    const attach = (assertionId: string, endPred: string, entityId: string) => {
      const assertNode = byId.get(assertionId);
      if (!assertNode || assertNode.type !== "Assertion") return;
      const ent = byId.get(entityId);
      if (!ent || ent.type !== "Entity") return;
      let bucket = byAssertion.get(assertionId);
      if (!bucket) {
        const fromLabel =
          (assertNode.label.match(
            /\b(worksAt|worksWith|reportsTo|supervisorOf|colleagueOf|spouseOf|parentOf|partOf|runs|workplaceRole|relatedTo|hiredBy)\b/i,
          )?.[1] ?? "relatedTo").replace(/^./, (c) => c.toLowerCase());
        bucket = { subjects: [], objects: [], predicate: fromLabel };
        byAssertion.set(assertionId, bucket);
      }
      if (endPred === "subject") bucket.subjects.push(entityId);
      else if (endPred === "object") bucket.objects.push(entityId);
    };

    // Canonical: Assertion --subject/object--> Entity
    if (s?.type === "Assertion" && (pred === "subject" || pred === "object")) {
      attach(l.source, pred, l.target);
    }
    // Defensive: Entity --subject/object--> Assertion
    if (t?.type === "Assertion" && (pred === "subject" || pred === "object")) {
      attach(l.target, pred, l.source);
    }
  }

  const projected: Array<GraphLink & { viaAssertion?: string }> = [];
  for (const [assertionId, bucket] of byAssertion) {
    for (const sub of bucket.subjects) {
      for (const obj of bucket.objects) {
        if (sub === obj) continue;
        projected.push({
          source: sub,
          target: obj,
          predicate: bucket.predicate,
          viaAssertion: assertionId,
        });
      }
    }
  }
  return projected;
}

/**
 * Shortest-path subgraph between two match sets (undirected).
 * If no path exists, returns both endpoint sets so the UI can show a miss.
 */
export function connectingSubgraph(
  links: GraphLink[],
  fromIds: Set<string>,
  toIds: Set<string>
): {
  nodeIds: Set<string>;
  linkKeys: Set<string>;
  hops: number | null;
  viaAssertions?: Set<string>;
} {
  const endpoints = new Set<string>([...fromIds, ...toIds]);
  if (!fromIds.size || !toIds.size) {
    return { nodeIds: endpoints, linkKeys: new Set(), hops: null };
  }

  const onlyA = [...fromIds].filter((id) => !toIds.has(id));
  const onlyB = [...toIds].filter((id) => !fromIds.has(id));
  // True "same node" only when every match is shared (no exclusive endpoints).
  if (onlyA.length === 0 && onlyB.length === 0) {
    return { nodeIds: new Set(fromIds), linkKeys: new Set(), hops: 0 };
  }

  const bfsFrom = new Set(onlyA.length ? onlyA : fromIds);
  const bfsTo = new Set(onlyB.length ? onlyB : toIds);

  const adj = new Map<
    string,
    Array<{ other: string; key: string; via?: string }>
  >();
  for (const l of links) {
    const via = (l as GraphLink & { viaAssertion?: string }).viaAssertion;
    const key = linkKey(l.source, l.target, l.predicate);
    if (!adj.has(l.source)) adj.set(l.source, []);
    if (!adj.has(l.target)) adj.set(l.target, []);
    adj.get(l.source)!.push({ other: l.target, key, via });
    adj.get(l.target)!.push({ other: l.source, key, via });
  }

  const parent = new Map<
    string,
    { prev: string; key: string; via?: string } | null
  >();
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const id of bfsFrom) {
    parent.set(id, null);
    dist.set(id, 0);
    queue.push(id);
  }

  let minHops: number | null = null;
  const reachedTargets: string[] = [];

  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi]!;
    const d = dist.get(id) ?? 0;
    if (minHops != null && d > minHops) break;

    if (bfsTo.has(id)) {
      minHops = d;
      reachedTargets.push(id);
      continue;
    }

    for (const edge of adj.get(id) ?? []) {
      if (parent.has(edge.other)) continue;
      parent.set(edge.other, { prev: id, key: edge.key, via: edge.via });
      dist.set(edge.other, d + 1);
      queue.push(edge.other);
    }
  }

  if (minHops == null || reachedTargets.length === 0) {
    return { nodeIds: endpoints, linkKeys: new Set(), hops: null };
  }

  const pathNodes = new Set<string>();
  const pathLinks = new Set<string>();
  const viaAssertions = new Set<string>();
  for (const target of reachedTargets) {
    if ((dist.get(target) ?? Infinity) > minHops) continue;
    let cur: string | undefined = target;
    pathNodes.add(cur);
    while (cur && !bfsFrom.has(cur)) {
      const step = parent.get(cur);
      if (!step) break;
      pathLinks.add(step.key);
      pathNodes.add(step.prev);
      if (step.via) viaAssertions.add(step.via);
      cur = step.prev;
    }
  }

  return { nodeIds: pathNodes, linkKeys: pathLinks, hops: minHops, viaAssertions };
}

/**
 * Grow a seed set by one hop, keeping Entity/Assertion neighbors so dual-search
 * shows related people (e.g. boss) around a devon↔uspto bridge.
 */
export function expandNeighborhood(
  nodes: GraphNode[],
  links: GraphLink[],
  seedIds: Set<string>,
  hops = 1
): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let keep = new Set(seedIds);
  for (let i = 0; i < hops; i++) {
    const grow = new Set(keep);
    for (const l of links) {
      const tryAdd = (id: string) => {
        if (keep.has(id) || grow.has(id)) return;
        const n = byId.get(id);
        if (!n) return;
        if (n.type === "Entity" || n.type === "Assertion") grow.add(id);
      };
      if (keep.has(l.source)) tryAdd(l.target);
      if (keep.has(l.target)) tryAdd(l.source);
    }
    keep = grow;
  }
  return keep;
}

export interface FilterGraphResult {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Present when both search boxes have terms. */
  bridge?: {
    hops: number | null;
    matchA: number;
    matchB: number;
    connected: boolean;
  };
}

export function matchNodeIds(nodes: GraphNode[], q: string): Set<string> {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return new Set();
  const needle = tokens.join(" ");

  const labelHits = nodes.filter((n) => labelMatchesTokens(n.label || "", tokens));
  let entities = labelHits.filter((n) => n.type === "Entity");

  // Exact label wins (e.g. "USPTO" over "USPTO is My HR Specialist")
  const exact = entities.filter((n) => (n.label || "").trim().toLowerCase() === needle);
  if (exact.length) entities = exact;

  // Prefer Organization when several exact org-like hits (Collection vs Organization)
  if (entities.length > 1) {
    const orgs = entities.filter((n) =>
      (n.schemaType || "").toLowerCase().includes("organization"),
    );
    if (orgs.length) entities = orgs;
  }

  const preferred = entities.length > 0 ? entities : labelHits.filter((n) => n.type !== "Assertion");
  const finalHits = preferred.length > 0 ? preferred : labelHits;
  if (finalHits.length > 0) return new Set(finalHits.map((n) => n.id));

  // Fallback: broader match when the label alone misses (acronym in searchText).
  const hits = nodes.filter((n) => nodeMatchesQuery(n, q));
  const hitEntities = hits.filter((n) => n.type === "Entity");
  return new Set((hitEntities.length > 0 ? hitEntities : hits).map((n) => n.id));
}

export function filterGraph(
  nodes: GraphNode[],
  links: GraphLink[],
  opts: { types: Set<string>; query: string; queryB?: string }
): FilterGraphResult {
  let filtered = nodes.filter((n) => nodePassesTypeFilter(n, opts.types));
  if (!filtered.length && nodes.length) filtered = [...nodes];

  const qA = opts.query.trim();
  const qB = (opts.queryB ?? "").trim();

  // Dual search: semantic Entity↔Entity path (via assertions), show path only —
  // do not fan out every assertion off intermediate people (that centers "Devon James").
  if (qA && qB) {
    const setA = matchNodeIds(nodes, qA);
    const setB = matchNodeIds(nodes, qB);
    const projected = projectEntityLinks(nodes, links);
    const bridge = connectingSubgraph(projected, setA, setB);

    const keep = new Set<string>(bridge.nodeIds);
    for (const id of bridge.viaAssertions ?? []) keep.add(id);
    // If disconnected, still show the matched endpoints
    if (bridge.hops == null) {
      for (const id of setA) keep.add(id);
      for (const id of setB) keep.add(id);
    }

    const outNodes = nodes.filter((n) => keep.has(n.id));
    const outIds = new Set(outNodes.map((n) => n.id));
    // Keep original assertion edges that touch kept nodes (subject/object spokes on the path)
    const outLinks = links.filter(
      (l) => outIds.has(l.source) && outIds.has(l.target)
    );

    return {
      nodes: outNodes,
      links: outLinks,
      bridge: {
        hops: bridge.hops,
        matchA: setA.size,
        matchB: setB.size,
        connected: bridge.hops != null,
      },
    };
  }

  const q = qA || qB;
  if (q) {
    const hitIds = new Set(
      filtered.filter((n) => nodeMatchesQuery(n, q)).map((n) => n.id)
    );
    for (const l of links) {
      if (hitIds.has(l.source)) hitIds.add(l.target);
      if (hitIds.has(l.target)) hitIds.add(l.source);
    }
    const allow = new Set(filtered.map((n) => n.id));
    filtered = nodes.filter((n) => allow.has(n.id) && hitIds.has(n.id));
  }

  const ids = new Set(filtered.map((n) => n.id));
  return {
    nodes: filtered,
    links: links.filter((l) => ids.has(l.source) && ids.has(l.target)),
  };
}

export function buildSimulation(
  nodes: GraphNode[],
  links: GraphLink[],
  width: number,
  height: number
): Simulation {
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) * 0.38;
  const count = Math.max(nodes.length, 1);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const byId = new Map<string, SimNode>();

  const simNodes = nodes.map((n, i) => {
    const t = (i + 0.5) / count;
    const radius = R * Math.sqrt(t) * 0.92;
    const angle = i * golden;
    const node: SimNode = {
      ...n,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
    byId.set(n.id, node);
    return node;
  });

  const simLinks = links
    .map((l) => ({
      source: byId.get(l.source)!,
      target: byId.get(l.target)!,
      predicate: l.predicate,
    }))
    .filter((l) => l.source && l.target);

  return { nodes: simNodes, links: simLinks, alpha: 1, width, height };
}

export function tickSimulation(sim: Simulation, pinnedId: string | null = null): void {
  const { nodes, links } = sim;
  const n = nodes.length;
  if (!n) return;

  const cx = sim.width / 2;
  const cy = sim.height / 2;
  const R = Math.min(sim.width, sim.height) * 0.38;
  const sample = n > 180 ? 2 : 1;

  for (let i = 0; i < n; i += sample) {
    const a = nodes[i]!;
    for (let j = i + sample; j < n; j += sample) {
      const b = nodes[j]!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist2 = dx * dx + dy * dy || 0.01;
      const force = 700 / dist2;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
  }

  for (const l of links) {
    const dx = l.target.x - l.source.x;
    const dy = l.target.y - l.source.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const k = 0.028 * (dist - 52);
    const fx = (dx / dist) * k;
    const fy = (dy / dist) * k;
    l.source.vx += fx;
    l.source.vy += fy;
    l.target.vx -= fx;
    l.target.vy -= fy;
  }

  for (const node of nodes) {
    if (pinnedId && node.id === pinnedId) continue;
    const dx = node.x - cx;
    const dy = node.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const ux = dx / dist;
    const uy = dy / dist;

    if (dist < R * 0.25) {
      node.vx += ux * 0.15;
      node.vy += uy * 0.15;
    }

    const target = R * 0.72;
    node.vx += ux * (target - dist) * 0.012;
    node.vy += uy * (target - dist) * 0.012;

    if (dist > R) {
      const pull = (dist - R) * 0.08;
      node.vx -= ux * pull;
      node.vy -= uy * pull;
    }

    node.vx += (cx - node.x) * 0.002;
    node.vy += (cy - node.y) * 0.002;
    node.vx *= 0.86;
    node.vy *= 0.86;
    node.x += node.vx * sim.alpha;
    node.y += node.vy * sim.alpha;
  }

  sim.alpha *= 0.988;
}
