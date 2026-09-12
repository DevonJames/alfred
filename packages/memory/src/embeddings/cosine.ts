/**
 * Cosine similarity helpers for embedding demos (original space is authoritative).
 */

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-12 ? 0 : dot / denom;
}

/** Full n×n cosine matrix (symmetric, diagonal = 1). */
export function pairwiseCosineMatrix(embeddings: number[][]): number[][] {
  const n = embeddings.length;
  const m: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    m[i]![i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = cosineSimilarity(embeddings[i]!, embeddings[j]!);
      m[i]![j] = c;
      m[j]![i] = c;
    }
  }
  return m;
}

/** Cosine distance in [0, 2]; for unit vectors ≈ 1 − cosine. */
export function cosineDistance(cosine: number): number {
  return Math.max(0, 1 - cosine);
}
