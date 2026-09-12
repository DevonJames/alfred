/**
 * Semantic Map builder for Graph (beta) / Vector Explorer-scale corpora.
 * Original cosine similarity is authoritative; projections are lossy.
 */

import { pairwiseCosineMatrix } from "./cosine.js";
import { projectCosineMds } from "./mds.js";
import {
  computeNeighborhoodMetrics,
  knnFromCosineMatrix,
  type NeighborhoodMetrics,
} from "./neighborhood-metrics.js";
import {
  projectEmbeddingsDirectional,
  projectEmbeddingsPca,
} from "../oip-local/pca.js";

export type SemanticMapMethod = "mds-cosine" | "pca" | "directional-pca";

export interface SemanticMapNeighbor {
  id: string;
  index: number;
  cosine: number;
}

export interface SemanticMapPoint {
  id: string;
  index: number;
  x: number;
  y: number;
  z: number;
  neighbors: SemanticMapNeighbor[];
  isOutlier: boolean;
}

export interface SemanticMapResult {
  method: string;
  dims: 2 | 3;
  disclaimer: string;
  points: SemanticMapPoint[];
  metrics: NeighborhoodMetrics;
  knnK: number;
}

const MDS_FULL_LIMIT = 700;
const LANDMARK_COUNT = 96;

function unitRows(vectors: number[][]): Float64Array[] {
  return vectors.map((v) => {
    const row = new Float64Array(v.length);
    let n = 0;
    for (let j = 0; j < v.length; j++) {
      row[j] = v[j]!;
      n += v[j]! * v[j]!;
    }
    const s = Math.sqrt(n) || 1;
    for (let j = 0; j < row.length; j++) row[j]! /= s;
    return row;
  });
}

function cosineUnit(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Farthest-point landmark sample on unit vectors (cosine distance). */
function pickLandmarks(rows: Float64Array[], count: number): number[] {
  const n = rows.length;
  const L = Math.min(count, n);
  const chosen: number[] = [Math.floor(Math.random() * n)];
  const minDist = new Float64Array(n);
  minDist.fill(Infinity);
  while (chosen.length < L) {
    const last = rows[chosen[chosen.length - 1]!]!;
    let farthest = 0;
    let farthestD = -1;
    for (let i = 0; i < n; i++) {
      const d = 1 - cosineUnit(rows[i]!, last);
      if (d < minDist[i]!) minDist[i] = d;
      if (minDist[i]! > farthestD) {
        farthestD = minDist[i]!;
        farthest = i;
      }
    }
    if (chosen.includes(farthest)) break;
    chosen.push(farthest);
  }
  return chosen;
}

/**
 * Landmark MDS: embed landmarks with classical MDS, place others as
 * cosine-weighted blends of landmark coordinates (scales to thousands of points).
 */
function landmarkCosineMds(
  ids: string[],
  embeddings: number[][],
  dims: 2 | 3,
  layoutScale: number,
): { positions: Record<string, { x: number; y: number; z: number }>; disclaimer: string } {
  const rows = unitRows(embeddings);
  const landmarkIdx = pickLandmarks(rows, LANDMARK_COUNT);
  const landmarkIds = landmarkIdx.map((i) => ids[i]!);
  const landmarkEmb = landmarkIdx.map((i) => embeddings[i]!);
  const subMatrix = pairwiseCosineMatrix(landmarkEmb);
  const mds = projectCosineMds(landmarkIds, subMatrix, dims, layoutScale);
  const landmarkPos = landmarkIdx.map((i) => mds.positions[ids[i]!] ?? { x: 0, y: 0, z: 0 });

  const positions: Record<string, { x: number; y: number; z: number }> = {};
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i]!;
    let wSum = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let li = 0; li < landmarkIdx.length; li++) {
      const cos = Math.max(0, cosineUnit(row, rows[landmarkIdx[li]!]!));
      const w = cos * cos;
      if (w < 1e-8) continue;
      const p = landmarkPos[li]!;
      wSum += w;
      x += w * p.x;
      y += w * p.y;
      z += w * p.z;
    }
    if (wSum < 1e-8) {
      positions[ids[i]!] = { x: 0, y: 0, z: 0 };
    } else {
      positions[ids[i]!] = { x: x / wSum, y: y / wSum, z: z / wSum };
    }
  }

  return {
    positions,
    disclaimer:
      "Landmark MDS (cosine) is a lossy approximation for large corpora. " +
      "Displayed distances are not original cosine distances — neighbor edges use original cosine.",
  };
}

/** Brute-force top-k neighbors using unit vectors. */
function knnExactUnit(rows: Float64Array[], k: number): Array<Array<{ index: number; cosine: number }>> {
  const n = rows.length;
  const kk = Math.max(0, Math.min(k, Math.max(0, n - 1)));
  const out: Array<Array<{ index: number; cosine: number }>> = Array.from({ length: n }, () => []);
  if (kk === 0) return out;

  for (let i = 0; i < n; i++) {
    const scored: Array<{ index: number; cosine: number }> = [];
    const a = rows[i]!;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      scored.push({ index: j, cosine: cosineUnit(a, rows[j]!) });
    }
    scored.sort((x, y) => y.cosine - x.cosine || x.index - y.index);
    out[i] = scored.slice(0, kk);
  }
  return out;
}

/** Brute-force top-k in a low-d space, then rescore candidates with full-dim cosine. */
function knnHybrid(
  fullRows: Float64Array[],
  knnK: number,
): Array<Array<{ index: number; cosine: number }>> {
  const n = fullRows.length;
  const kk = Math.max(0, Math.min(knnK, Math.max(0, n - 1)));
  const out: Array<Array<{ index: number; cosine: number }>> = Array.from({ length: n }, () => []);
  if (kk === 0) return out;

  // Fast path for small corpora
  if (n <= 900) return knnExactUnit(fullRows, kk);

  // Reduce to ~32-d via power-iteration components of XᵀX on unit rows
  const dim = fullRows[0]!.length;
  const comps: Float64Array[] = [];
  const tmp = new Float64Array(dim);
  const apply = (v: Float64Array) => {
    tmp.fill(0);
    const xv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const row = fullRows[i]!;
      for (let j = 0; j < dim; j++) s += row[j]! * v[j]!;
      xv[i] = s;
    }
    for (let i = 0; i < n; i++) {
      const s = xv[i]!;
      const row = fullRows[i]!;
      for (let j = 0; j < dim; j++) tmp[j]! += s * row[j]!;
    }
    for (const prev of comps) {
      let d = 0;
      for (let j = 0; j < dim; j++) d += tmp[j]! * prev[j]!;
      for (let j = 0; j < dim; j++) tmp[j]! -= d * prev[j]!;
    }
    let nn = 0;
    for (let j = 0; j < dim; j++) nn += tmp[j]! * tmp[j]!;
    nn = Math.sqrt(nn) || 1;
    for (let j = 0; j < dim; j++) tmp[j]! /= nn;
  };
  const lowD = 32;
  for (let c = 0; c < lowD; c++) {
    const v = new Float64Array(dim);
    for (let j = 0; j < dim; j++) v[j] = Math.random() * 2 - 1;
    let nn = 0;
    for (let j = 0; j < dim; j++) nn += v[j]! * v[j]!;
    nn = Math.sqrt(nn) || 1;
    for (let j = 0; j < dim; j++) v[j]! /= nn;
    for (let t = 0; t < 24; t++) {
      apply(v);
      v.set(tmp);
    }
    comps.push(Float64Array.from(v));
  }
  const reduced: Float64Array[] = fullRows.map((row) => {
    const r = new Float64Array(lowD);
    for (let c = 0; c < lowD; c++) {
      let s = 0;
      const comp = comps[c]!;
      for (let j = 0; j < dim; j++) s += row[j]! * comp[j]!;
      r[c] = s;
    }
    let nn = 0;
    for (let c = 0; c < lowD; c++) nn += r[c]! * r[c]!;
    nn = Math.sqrt(nn) || 1;
    for (let c = 0; c < lowD; c++) r[c]! /= nn;
    return r;
  });

  const candidateK = Math.min(n - 1, Math.max(kk * 8, 40));
  for (let i = 0; i < n; i++) {
    const scored: Array<{ index: number; cosine: number }> = [];
    const a = reduced[i]!;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      scored.push({ index: j, cosine: cosineUnit(a, reduced[j]!) });
    }
    scored.sort((x, y) => y.cosine - x.cosine);
    const candidates = scored.slice(0, candidateK);
    const exact = candidates.map((c) => ({
      index: c.index,
      cosine: cosineUnit(fullRows[i]!, fullRows[c.index]!),
    }));
    exact.sort((x, y) => y.cosine - x.cosine || x.index - y.index);
    out[i] = exact.slice(0, kk);
  }
  return out;
}

export function buildSemanticMap(opts: {
  ids: string[];
  embeddings: number[][];
  method?: SemanticMapMethod;
  dims?: 2 | 3;
  knnK?: number;
  /** Optional ground-truth / type labels for metrics + reveal (not used in projection). */
  categories?: Array<string | null | undefined>;
  layoutScale?: number;
}): SemanticMapResult {
  const ids = opts.ids;
  const embeddings = opts.embeddings;
  if (ids.length !== embeddings.length) {
    throw new Error("buildSemanticMap: ids/embeddings length mismatch");
  }
  const method = opts.method ?? "mds-cosine";
  const dims = opts.dims ?? 2;
  const knnK = Math.max(1, Math.min(12, opts.knnK ?? 3));
  const layoutScale = opts.layoutScale ?? 420;
  const n = ids.length;

  let positions: Record<string, { x: number; y: number; z: number }>;
  let disclaimer: string;
  let methodOut: string = method;

  if (method === "pca") {
    const proj = projectEmbeddingsPca(ids, embeddings, layoutScale);
    positions = proj.positions;
    methodOut = "pca";
    disclaimer =
      "Centered PCA is a lossy projection optimized for variance, not local neighborhoods. " +
      "Original cosine similarities remain authoritative.";
  } else if (method === "directional-pca") {
    const proj = projectEmbeddingsDirectional(ids, embeddings, layoutScale);
    positions = proj.positions;
    methodOut = "directional-pca";
    disclaimer =
      "Directional PCA on unit vectors is a lossy projection. Prefer MDS (cosine) for neighborhoods. " +
      "Original cosines remain authoritative.";
  } else if (n <= MDS_FULL_LIMIT) {
    const matrix = pairwiseCosineMatrix(embeddings);
    const proj = projectCosineMds(ids, matrix, dims, layoutScale);
    positions = proj.positions;
    methodOut = "mds-cosine";
    disclaimer = proj.disclaimer;
  } else {
    const proj = landmarkCosineMds(ids, embeddings, dims, layoutScale);
    positions = proj.positions;
    methodOut = "mds-cosine-landmark";
    disclaimer = proj.disclaimer;
  }

  if (dims === 2) {
    for (const id of ids) {
      const p = positions[id];
      if (p) p.z = 0;
    }
  }

  const rows = unitRows(embeddings);
  const knn = knnHybrid(rows, knnK);
  // Build a dense cosine matrix only if small enough for metrics; else sparse via knn
  let cosineMatrix: number[][];
  if (n <= MDS_FULL_LIMIT) {
    cosineMatrix = pairwiseCosineMatrix(embeddings);
  } else {
    cosineMatrix = Array.from({ length: n }, (_, i) => {
      const row = Array(n).fill(0);
      row[i] = 1;
      for (const nb of knn[i]!) row[nb.index] = nb.cosine;
      return row;
    });
    // Fill symmetric knn hits
    for (let i = 0; i < n; i++) {
      for (const nb of knn[i]!) {
        cosineMatrix[nb.index]![i] = Math.max(cosineMatrix[nb.index]![i]!, nb.cosine);
      }
    }
  }

  const posList = ids.map((id) => positions[id] ?? { x: 0, y: 0, z: 0 });
  const metrics = computeNeighborhoodMetrics({
    cosineMatrix,
    categories: opts.categories,
    positions: posList,
    knnK,
  });

  const points: SemanticMapPoint[] = ids.map((id, i) => ({
    id,
    index: i + 1,
    x: posList[i]!.x,
    y: posList[i]!.y,
    z: posList[i]!.z,
    neighbors: (knn[i] ?? []).map((nb) => ({
      id: ids[nb.index]!,
      index: nb.index + 1,
      cosine: Number(nb.cosine.toFixed(4)),
    })),
    isOutlier: metrics.outlierIndices.includes(i),
  }));

  return {
    method: methodOut,
    dims,
    disclaimer,
    points,
    metrics,
    knnK,
  };
}

/** Re-export for callers that already have a cosine matrix + want Vector Explorer parity. */
export { knnFromCosineMatrix };
