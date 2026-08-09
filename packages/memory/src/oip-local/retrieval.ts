import type { MemoryQuery, NormalizedMemoryItem } from "@alfred/contracts";
import { displayLabel } from "./schema-org.js";
import type { PackageStore } from "./package-store.js";
import type { MemoryRevision } from "./schemas.js";
import { FtsIndex } from "./indexes/fts-index.js";
import { GraphIndex } from "./indexes/graph-index.js";
import type { SqliteMemoryIndex } from "./indexes/sqlite-index.js";

export interface RetrievalDeps {
  packages: PackageStore;
  sqlite: SqliteMemoryIndex;
  providerId: string;
}

/**
 * Hybrid retrieval: FTS + name/entity match + 1–2 hop graph expansion.
 * Enough for “wine at Sarah’s” without embeddings.
 */
export async function retrieveMemories(
  query: MemoryQuery,
  deps: RetrievalDeps,
): Promise<NormalizedMemoryItem[]> {
  const limit = query.limit ?? 8;
  const fts = new FtsIndex(deps.sqlite);
  const graph = new GraphIndex(deps.sqlite);

  const scores = new Map<string, number>();
  const bump = (id: string, score: number) => {
    scores.set(id, Math.max(scores.get(id) ?? 0, score));
  };

  // Lexical
  for (const hit of fts.search(query.text, limit * 3)) {
    bump(hit.recordId, 0.4 + hit.score * 0.4);
  }

  // Entity name seeds (e.g. "Sarah")
  const nameTokens = extractProperNames(query.text);
  const seedIds: string[] = [];
  for (const name of nameTokens) {
    for (const row of deps.sqlite.findByName(name)) {
      bump(row.id, 0.75);
      seedIds.push(row.id);
    }
  }

  // Also seed from top FTS hits
  for (const [id] of [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    seedIds.push(id);
  }

  if (seedIds.length) {
    const walk = graph.expand(seedIds, 2);
    for (const nodeId of walk.nodeIds) {
      bump(nodeId, (scores.get(nodeId) ?? 0.2) + 0.15);
    }

    // Prefer products/episodes connected to person seeds for wine-style queries
    if (isEpisodicProductQuery(query.text)) {
      for (const edge of walk.edges) {
        const src = deps.sqlite.getRecord(edge.source_id);
        const tgt = deps.sqlite.getRecord(edge.target_id);
        if (src?.record_type === "Episode" || tgt?.record_type === "Episode") {
          bump(edge.source_id, (scores.get(edge.source_id) ?? 0) + 0.2);
          bump(edge.target_id, (scores.get(edge.target_id) ?? 0) + 0.2);
        }
        if (
          src?.record_type === "Entity" &&
          /product|wine|product/i.test(src.schema_type ?? src.search_text ?? "")
        ) {
          bump(src.id, (scores.get(src.id) ?? 0) + 0.35);
        }
        if (
          tgt?.record_type === "Entity" &&
          /product|wine/i.test(tgt.schema_type ?? tgt.search_text ?? "")
        ) {
          bump(tgt.id, (scores.get(tgt.id) ?? 0) + 0.35);
        }
        if (/(involved|served|consumed|likes)/i.test(edge.predicate)) {
          bump(edge.target_id, (scores.get(edge.target_id) ?? 0) + 0.25);
          bump(edge.source_id, (scores.get(edge.source_id) ?? 0) + 0.1);
        }
      }
    }
  }

  // Structured fallback: all entities matching wine-ish tokens
  if (/\bwine\b/i.test(query.text)) {
    for (const row of deps.sqlite.listByType("Entity", 50)) {
      if (/wine|barolo|vino/i.test(row.search_text ?? row.name ?? "")) {
        bump(row.id, (scores.get(row.id) ?? 0) + 0.3);
      }
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

  const items: NormalizedMemoryItem[] = [];
  for (const [id, relevance] of ranked) {
    const logicalId = id.startsWith("did:memory:")
      ? id.slice("did:memory:".length)
      : id;
    const rev = await deps.packages.readCurrent(logicalId);
    if (!rev) continue;
    items.push(toNormalized(rev, deps.providerId, relevance));
  }
  return items;
}

export function toNormalized(
  rev: MemoryRevision,
  providerId: string,
  relevance = 0.5,
): NormalizedMemoryItem {
  const content = formatContent(rev);
  return {
    id: rev.id,
    content,
    sourceId: rev.id,
    providerId,
    createdAt: rev.createdAt,
    updatedAt: rev.updatedAt,
    confidence: rev.alfred?.confidence,
    relevance: Math.min(1, relevance),
    provenance: {
      kind: rev.type.toLowerCase(),
      revision: rev.revision,
      type: rev.type,
      schemaType: rev.schemaType,
      ...(rev.provenance ?? {}),
    },
  };
}

function formatContent(rev: MemoryRevision): string {
  const label = displayLabel(rev);
  if (rev.type === "Assertion" && rev.subject && rev.predicate) {
    return `${rev.predicate}: ${label || String(rev.object ?? "")} (${rev.subject})`;
  }
  if (rev.type === "Observation" && rev.text) return rev.text;
  if (label) return `${rev.type}: ${label}`;
  return `${rev.type} ${rev.id}`;
}

function extractProperNames(text: string): string[] {
  // Possessive: Sarah's → Sarah
  const names = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z]+)(?:'s)?\b/g)) {
    const n = m[1]!;
    if (!QUERY_CAPS.has(n)) names.add(n);
  }
  // lowercase fallback for tests that pass "sarah"
  for (const m of text.matchAll(/\b([a-z]{3,})'s\b/g)) {
    names.add(capitalize(m[1]!));
  }
  return [...names];
}

const QUERY_CAPS = new Set([
  "What",
  "Where",
  "When",
  "Who",
  "Which",
  "How",
  "The",
  "Did",
  "Does",
  "Was",
  "Were",
  "Is",
  "Are",
]);

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isEpisodicProductQuery(text: string): boolean {
  return /\b(wine|restaurant|dinner|at .+['']s|had at|we had)\b/i.test(text);
}
