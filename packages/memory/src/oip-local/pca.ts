/**
 * Lightweight PCA for projecting embedding vectors to 3D (visualization only).
 * Matrix-free power iteration on XᵀX — no external math deps, no full covariance.
 */

export interface PcaProjection3d {
  method: "pca" | "directional-pca";
  dimensions: 3;
  /** Rough extent used to scale layout into graph space. */
  scale: number;
  positions: Record<string, { x: number; y: number; z: number }>;
}

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

function toUnitRows(vectors: number[][]): Float64Array[] {
  return vectors.map((v) => {
    const row = new Float64Array(v.length);
    for (let j = 0; j < v.length; j++) row[j] = v[j]!;
    normalizeInPlace(row);
    return row;
  });
}

/** Top-k components of XᵀX via power iteration (rows already prepared). */
function topComponentsXtX(rows: Float64Array[], k: number): Float64Array[] {
  const n = rows.length;
  const dim = rows[0]!.length;
  const applyXtX = (v: Float64Array, out: Float64Array, prior: Float64Array[]): void => {
    out.fill(0);
    const xv = new Float64Array(n);
    for (let i = 0; i < n; i++) xv[i] = dot(rows[i]!, v);
    for (let i = 0; i < n; i++) {
      const scale = xv[i]!;
      const row = rows[i]!;
      for (let j = 0; j < dim; j++) out[j]! += scale * row[j]!;
    }
    for (const prev of prior) {
      const d = dot(out, prev);
      for (let j = 0; j < dim; j++) out[j]! -= d * prev[j]!;
    }
  };

  const comps: Float64Array[] = [];
  const tmp = new Float64Array(dim);
  for (let comp = 0; comp < k; comp++) {
    const v = new Float64Array(dim);
    for (let j = 0; j < dim; j++) v[j] = Math.random() * 2 - 1;
    normalizeInPlace(v);
    for (let t = 0; t < 48; t++) {
      applyXtX(v, tmp, comps);
      normalizeInPlace(tmp);
      v.set(tmp);
    }
    comps.push(Float64Array.from(v));
  }
  return comps;
}

function scalePositions(
  ids: string[],
  coords: Array<{ x: number; y: number; z: number }>,
  layoutScale: number,
  method: PcaProjection3d["method"],
): PcaProjection3d {
  let maxAbs = 1e-9;
  for (const p of coords) {
    maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  }
  const scale = layoutScale / maxAbs;
  const positions: Record<string, { x: number; y: number; z: number }> = {};
  for (let i = 0; i < ids.length; i++) {
    const p = coords[i]!;
    positions[ids[i]!] = {
      x: p.x * scale,
      y: p.y * scale,
      z: p.z * scale,
    };
  }
  return { method, dimensions: 3, scale: layoutScale, positions };
}

/**
 * Classic centered PCA — good for clouds / residual structure.
 * Not ideal for "arrows from origin" demos of cosine similarity.
 */
export function projectEmbeddingsPca(
  ids: string[],
  vectors: number[][],
  layoutScale = 420,
): PcaProjection3d {
  if (ids.length === 0 || vectors.length === 0) {
    return { method: "pca", dimensions: 3, scale: layoutScale, positions: {} };
  }
  if (ids.length !== vectors.length) {
    throw new Error("projectEmbeddingsPca: ids and vectors length mismatch");
  }

  const n = vectors.length;
  const dim = vectors[0]!.length;
  if (dim < 3) throw new Error("projectEmbeddingsPca: need at least 3 dimensions");

  const mean = new Float64Array(dim);
  for (const v of vectors) {
    for (let j = 0; j < dim; j++) mean[j]! += v[j]!;
  }
  for (let j = 0; j < dim; j++) mean[j]! /= n;

  const centered: Float64Array[] = vectors.map((v) => {
    const c = new Float64Array(dim);
    for (let j = 0; j < dim; j++) c[j] = v[j]! - mean[j]!;
    return c;
  });

  const comps = topComponentsXtX(centered, 3);
  const coords = centered.map((c) => ({
    x: dot(c, comps[0]!),
    y: dot(c, comps[1]!),
    z: dot(c, comps[2]!),
  }));

  return scalePositions(ids, coords, layoutScale, "pca");
}

/**
 * Direction-preserving projection for vector demos:
 * L2-normalize each embedding, then uncentered PCA (SVD of X).
 *
 * Similar meanings share a dominant direction (narrow cone from the origin).
 * Centered PCA would subtract that shared direction and exaggerate tiny residuals.
 */
export function projectEmbeddingsDirectional(
  ids: string[],
  vectors: number[][],
  layoutScale = 220,
): PcaProjection3d {
  if (ids.length === 0 || vectors.length === 0) {
    return { method: "directional-pca", dimensions: 3, scale: layoutScale, positions: {} };
  }
  if (ids.length !== vectors.length) {
    throw new Error("projectEmbeddingsDirectional: ids and vectors length mismatch");
  }

  const dim = vectors[0]!.length;
  if (dim < 3) throw new Error("projectEmbeddingsDirectional: need at least 3 dimensions");

  const rows = toUnitRows(vectors);
  const comps = topComponentsXtX(rows, 3);

  // Project unit vectors into the uncentered basis, then re-unitize in 3D
  // so arrow length stays equal and angle ≈ cosine geometry.
  const coords = rows.map((row) => {
    const x = dot(row, comps[0]!);
    const y = dot(row, comps[1]!);
    const z = dot(row, comps[2]!);
    const len = Math.hypot(x, y, z) || 1;
    return { x: x / len, y: y / len, z: z / len };
  });

  return scalePositions(ids, coords, layoutScale, "directional-pca");
}
