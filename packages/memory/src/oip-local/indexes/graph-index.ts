import type { EdgeRow, SqliteMemoryIndex } from "./sqlite-index.js";

export interface GraphWalkResult {
  nodeIds: string[];
  edges: EdgeRow[];
  paths: string[][];
}

/**
 * BFS graph traversal over the SQLite edge table.
 */
export class GraphIndex {
  constructor(private readonly sqlite: SqliteMemoryIndex) {}

  neighbors(nodeId: string): EdgeRow[] {
    const out = this.sqlite.edgesFrom(nodeId);
    const inbound = this.sqlite.edgesTo(nodeId);
    return [...out, ...inbound];
  }

  /**
   * Expand from seed ids up to `maxHops` (default 2).
   */
  expand(seedIds: string[], maxHops = 2): GraphWalkResult {
    const visited = new Set<string>(seedIds.map(normalizeId));
    const edges: EdgeRow[] = [];
    const paths: string[][] = seedIds.map((id) => [normalizeId(id)]);
    let frontier = [...visited];

    for (let hop = 0; hop < maxHops; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of this.neighbors(id)) {
          edges.push(edge);
          for (const n of [normalizeId(edge.source_id), normalizeId(edge.target_id)]) {
            if (!visited.has(n)) {
              visited.add(n);
              next.push(n);
              const parentPath = paths.find((p) => p[p.length - 1] === id);
              paths.push([...(parentPath ?? [id]), n]);
            }
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }

    return { nodeIds: [...visited], edges, paths };
  }
}

function normalizeId(id: string): string {
  return id.startsWith("did:memory:") ? id.split("#")[0]! : `did:memory:${id}`;
}
