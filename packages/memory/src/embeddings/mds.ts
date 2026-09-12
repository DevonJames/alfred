/**
 * Classical MDS on a distance matrix — preserves pairwise distances as well as
 * a linear embedding of the Gram matrix can (visualization only; lossy).
 */

export interface MdsProjection {
  method: "mds-cosine";
  dimensions: 2 | 3;
  scale: number;
  positions: Record<string, { x: number; y: number; z: number }>;
  disclaimer: string;
}

const MDS_DISCLAIMER =
  "MDS (cosine distance) is a lossy 2D/3D projection of the original embedding space. " +
  "Displayed distances are not the original cosine distances — use the cosine matrix for similarity.";

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: Float64Array): number {
  return Math.sqrt(dot(a, a));
}

function normalizeInPlace(a: Float64Array): void {
  const n = norm(a);
  if (n < 1e-12) return;
  for (let i = 0; i < a.length; i++) a[i]! /= n;
}

/** Power iteration for top eigenvector of a symmetric n×n matrix (row-major). */
function topEigen(mat: Float64Array, n: number, iters = 64): { value: number; vector: Float64Array } {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.random() * 2 - 1;
  normalizeInPlace(v);
  const tmp = new Float64Array(n);
  for (let t = 0; t < iters; t++) {
    tmp.fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const row = i * n;
      for (let j = 0; j < n; j++) s += mat[row + j]! * v[j]!;
      tmp[i] = s;
    }
    normalizeInPlace(tmp);
    v.set(tmp);
  }
  let value = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const row = i * n;
    for (let j = 0; j < n; j++) s += mat[row + j]! * v[j]!;
    value += v[i]! * s;
  }
  return { value, vector: Float64Array.from(v) };
}

function deflate(mat: Float64Array, n: number, value: number, vector: Float64Array): void {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      mat[i * n + j]! -= value * vector[i]! * vector[j]!;
    }
  }
}

/**
 * Classical MDS from an n×n distance matrix (zeros on diagonal).
 * Returns coordinates in `dims` dimensions, scaled to layoutScale.
 */
export function classicalMds(
  ids: string[],
  distances: number[][],
  dims: 2 | 3,
  layoutScale = 280,
): MdsProjection {
  const n = ids.length;
  if (n === 0) {
    return {
      method: "mds-cosine",
      dimensions: dims,
      scale: layoutScale,
      positions: {},
      disclaimer: MDS_DISCLAIMER,
    };
  }

  // Double-center squared distances → Gram matrix B
  const D2 = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = distances[i]![j] ?? 0;
      D2[i * n + j] = d * d;
    }
  }
  const rowMean = new Float64Array(n);
  const colMean = new Float64Array(n);
  let grand = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = D2[i * n + j]!;
      rowMean[i]! += v;
      colMean[j]! += v;
      grand += v;
    }
  }
  for (let i = 0; i < n; i++) {
    rowMean[i]! /= n;
    colMean[i]! /= n;
  }
  grand /= n * n;

  const B = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      B[i * n + j] = -0.5 * (D2[i * n + j]! - rowMean[i]! - colMean[j]! + grand);
    }
  }

  const coords = Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0 }));
  const working = Float64Array.from(B);
  for (let d = 0; d < dims; d++) {
    const { value, vector } = topEigen(working, n);
    const scale = value > 0 ? Math.sqrt(value) : 0;
    for (let i = 0; i < n; i++) {
      const c = coords[i]!;
      const component = scale * vector[i]!;
      if (d === 0) c.x = component;
      else if (d === 1) c.y = component;
      else c.z = component;
    }
    deflate(working, n, value, vector);
  }

  let maxAbs = 1e-9;
  for (const c of coords) {
    maxAbs = Math.max(maxAbs, Math.abs(c.x), Math.abs(c.y), Math.abs(c.z));
  }
  const s = layoutScale / maxAbs;
  const positions: Record<string, { x: number; y: number; z: number }> = {};
  for (let i = 0; i < n; i++) {
    const c = coords[i]!;
    positions[ids[i]!] = { x: c.x * s, y: c.y * s, z: c.z * s };
  }

  return {
    method: "mds-cosine",
    dimensions: dims,
    scale: layoutScale,
    positions,
    disclaimer: MDS_DISCLAIMER,
  };
}

/** Build cosine-distance matrix from cosine similarity matrix, then MDS. */
export function projectCosineMds(
  ids: string[],
  cosineMatrix: number[][],
  dims: 2 | 3,
  layoutScale = 280,
): MdsProjection {
  const n = ids.length;
  const distances: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) distances[i]![j] = 0;
      else distances[i]![j] = Math.max(0, 1 - (cosineMatrix[i]![j] ?? 0));
    }
  }
  return classicalMds(ids, distances, dims, layoutScale);
}
