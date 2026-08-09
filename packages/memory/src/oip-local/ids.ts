import { ulid } from "ulid";
import { HASH_ALGORITHM, type TaggedHash, parseTaggedHash } from "./hashing.js";

export const MEMORY_DID_PREFIX = "did:memory:" as const;

export type MemoryDid = `${typeof MEMORY_DID_PREFIX}${string}`;

export interface ParsedMemoryRef {
  logicalId: string;
  did: MemoryDid;
  /** Present when ref targets an exact revision. */
  revision: TaggedHash | null;
}

export function newLogicalId(): string {
  return ulid();
}

export function toMemoryDid(logicalId: string): MemoryDid {
  const id = logicalId.startsWith(MEMORY_DID_PREFIX)
    ? logicalId.slice(MEMORY_DID_PREFIX.length)
    : logicalId;
  return `${MEMORY_DID_PREFIX}${id}`;
}

export function logicalIdFromDid(did: string): string {
  if (!did.startsWith(MEMORY_DID_PREFIX)) {
    throw new Error(`Not a did:memory id: ${did}`);
  }
  const rest = did.slice(MEMORY_DID_PREFIX.length);
  const hashIdx = rest.indexOf("#");
  return hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
}

/** Parse `did:memory:<id>` or `did:memory:<id>#sha256:<hex>`. */
export function parseMemoryRef(ref: string): ParsedMemoryRef {
  if (!ref.startsWith(MEMORY_DID_PREFIX)) {
    throw new Error(`Not a did:memory ref: ${ref}`);
  }
  const body = ref.slice(MEMORY_DID_PREFIX.length);
  const hashIdx = body.indexOf("#");
  if (hashIdx < 0) {
    const logicalId = body;
    if (!logicalId) throw new Error(`Empty did:memory id: ${ref}`);
    return { logicalId, did: toMemoryDid(logicalId), revision: null };
  }
  const logicalId = body.slice(0, hashIdx);
  const fragment = body.slice(hashIdx + 1);
  const { algorithm, hex } = parseTaggedHash(fragment.includes(":") ? fragment : `${HASH_ALGORITHM}:${fragment}`);
  const revision = `${algorithm}:${hex}` as TaggedHash;
  return { logicalId, did: toMemoryDid(logicalId), revision };
}

export function revisionSpecificDid(did: MemoryDid | string, revision: TaggedHash): string {
  const logicalId = logicalIdFromDid(did.startsWith(MEMORY_DID_PREFIX) ? did : toMemoryDid(did));
  return `${MEMORY_DID_PREFIX}${logicalId}#${revision}`;
}

export function isMemoryDid(value: string): boolean {
  return value.startsWith(MEMORY_DID_PREFIX);
}
