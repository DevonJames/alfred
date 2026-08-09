import type { TaggedHash } from "./hashing.js";
import { isMemoryDid, parseMemoryRef, type ParsedMemoryRef } from "./ids.js";
import type { MemoryRevision } from "./schemas.js";

export interface DrefLookup {
  getCurrent(logicalId: string): Promise<MemoryRevision | null>;
  getRevision(logicalId: string, revision: TaggedHash): Promise<MemoryRevision | null>;
}

export interface ResolveOptions {
  depth?: number;
  /** Max recursion depth (OIP resolveDepth). Default 2. */
  maxDepth?: number;
}

export type ResolvedValue =
  | MemoryRevision
  | { _unresolved: string }
  | { _circular: string; id: string }
  | ResolvedValue[]
  | { [key: string]: ResolvedValue | unknown };

/**
 * Resolve a single dref string to a revision (current or exact).
 */
export async function resolveDref(
  ref: string,
  lookup: DrefLookup,
): Promise<MemoryRevision | null> {
  if (!isMemoryDid(ref)) return null;
  const parsed = parseMemoryRef(ref);
  if (parsed.revision) {
    return lookup.getRevision(parsed.logicalId, parsed.revision);
  }
  return lookup.getCurrent(parsed.logicalId);
}

/**
 * Recursively expand dref-looking string fields inside a record.
 * Mutates a deep clone; does not mutate the input.
 */
export async function resolveRecordDrefs(
  record: MemoryRevision,
  lookup: DrefLookup,
  options: ResolveOptions = {},
): Promise<MemoryRevision & { _resolved?: Record<string, unknown> }> {
  const maxDepth = options.maxDepth ?? options.depth ?? 2;
  const visited = new Set<string>();
  const clone = structuredClone(record) as MemoryRevision & {
    _resolved?: Record<string, unknown>;
  };
  clone._resolved = (await walk(clone, lookup, maxDepth, 0, visited)) as Record<string, unknown>;
  return clone;
}

async function walk(
  value: unknown,
  lookup: DrefLookup,
  maxDepth: number,
  depth: number,
  visited: Set<string>,
): Promise<unknown> {
  if (typeof value === "string" && isMemoryDid(value)) {
    if (depth >= maxDepth) return { _unresolved: value };
    const parsed = parseMemoryRef(value);
    const key = parsed.revision ? `${parsed.logicalId}#${parsed.revision}` : parsed.logicalId;
    if (visited.has(key)) return { _circular: true, id: value };
    visited.add(key);
    const resolved = parsed.revision
      ? await lookup.getRevision(parsed.logicalId, parsed.revision)
      : await lookup.getCurrent(parsed.logicalId);
    if (!resolved) return { _unresolved: value };
    const nested = structuredClone(resolved) as Record<string, unknown>;
    // Expand nested drefs one level deeper
    for (const [k, v] of Object.entries(nested)) {
      if (k === "revision" || k === "previousRevision" || k === "id") continue;
      nested[k] = await walk(v, lookup, maxDepth, depth + 1, visited);
    }
    return nested;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => walk(v, lookup, maxDepth, depth, visited)));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await walk(v, lookup, maxDepth, depth, visited);
    }
    return out;
  }
  return value;
}

/** Collect all did:memory refs from a revision for graph indexing. */
export function collectDrefs(record: MemoryRevision): Array<{ predicate: string; target: string }> {
  const edges: Array<{ predicate: string; target: string }> = [];

  const add = (predicate: string, target: unknown) => {
    if (typeof target === "string" && isMemoryDid(target)) {
      edges.push({ predicate, target });
    } else if (Array.isArray(target)) {
      for (const t of target) add(predicate, t);
    }
  };

  add("subject", record.subject);
  add("object", record.object);
  add("location", record.location);
  add("speaker", record.speaker);
  add("sourceArtifact", record.sourceArtifact);
  add("participants", record.participants);
  add("supersedes", record.supersedes);
  add("contradicts", record.contradicts);
  add("reinforces", record.reinforces);

  if (record.drefs && typeof record.drefs === "object") {
    for (const [pred, target] of Object.entries(record.drefs)) {
      add(pred, target);
    }
  }

  if (record.provenance?.source && typeof record.provenance.source === "string") {
    add("provenance.source", record.provenance.source);
  }

  return edges;
}

export type { ParsedMemoryRef };
