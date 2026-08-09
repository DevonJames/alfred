import { createHash } from "node:crypto";

export const HASH_ALGORITHM = "sha256" as const;
export type HashAlgorithm = typeof HASH_ALGORITHM;

/** Tagged content hash, e.g. `sha256:abc…`. */
export type TaggedHash = `${HashAlgorithm}:${string}`;

export function hashBytes(bytes: Uint8Array | Buffer | string): TaggedHash {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

export function parseTaggedHash(value: string): { algorithm: string; hex: string } {
  const idx = value.indexOf(":");
  if (idx <= 0) {
    throw new Error(`Invalid tagged hash (expected algorithm:hex): ${value}`);
  }
  const algorithm = value.slice(0, idx);
  const hex = value.slice(idx + 1);
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`Invalid hash hex: ${value}`);
  }
  return { algorithm, hex: hex.toLowerCase() };
}

export function hashToFilename(hash: TaggedHash): string {
  const { algorithm, hex } = parseTaggedHash(hash);
  return `${algorithm}-${hex}`;
}

/** Shard path segments from hex: ab/cd */
export function hashShardPath(hex: string): string {
  const h = hex.toLowerCase();
  return pathJoin(h.slice(0, 2), h.slice(2, 4));
}

function pathJoin(a: string, b: string): string {
  return `${a}/${b}`;
}
