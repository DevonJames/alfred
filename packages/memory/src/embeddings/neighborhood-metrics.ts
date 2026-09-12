/**
 * Neighborhood / cluster quality metrics for embedding demos.
 * All similarity uses the ORIGINAL cosine matrix — never projected distances.
 */

export interface NeighborHit {
  index: number;
  cosine: number;
}

export interface OutlierHit {
  index: number;
  nearestCosine: number;
}

export interface NeighborhoodMetrics {
  withinGroupCosine: number | null;
  betweenGroupCosine: number | null;
  nnCategoryAccuracy: number | null;
  silhouetteCosine: number | null;
  /** Fraction of k-NN in original space that remain among k-NN in projection (proxy trustworthiness). */
  projectionNeighborhoodRetention: number | null;
  outlierIndices: number[];
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function knnFromCosineMatrix(
  cosineMatrix: number[][],
  k: number,
): NeighborHit[][] {
  const n = cosineMatrix.length;
  const kk = Math.max(0, Math.min(k, Math.max(0, n - 1)));
  const out: NeighborHit[][] = [];
  for (let i = 0; i < n; i++) {
    const scored: NeighborHit[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      scored.push({ index: j, cosine: cosineMatrix[i]![j]! });
    }
    scored.sort((a, b) => b.cosine - a.cosine || a.index - b.index);
    out.push(scored.slice(0, kk));
  }
  return out;
}

export function projectedDistance(
  a: { x: number; y: number; z?: number },
  b: { x: number; y: number; z?: number },
): number {
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.hypot(a.x - b.x, a.y - b.y, dz);
}

/** Average cosine among pairs that share a category label. */
export function withinGroupCosine(
  cosineMatrix: number[][],
  categories: Array<string | null | undefined>,
): number | null {
  const vals: number[] = [];
  for (let i = 0; i < categories.length; i++) {
    const ci = categories[i];
    if (!ci) continue;
    for (let j = i + 1; j < categories.length; j++) {
      if (categories[j] !== ci) continue;
      vals.push(cosineMatrix[i]![j]!);
    }
  }
  return mean(vals);
}

/** Average cosine among pairs with different non-null category labels. */
export function betweenGroupCosine(
  cosineMatrix: number[][],
  categories: Array<string | null | undefined>,
): number | null {
  const vals: number[] = [];
  for (let i = 0; i < categories.length; i++) {
    const ci = categories[i];
    if (!ci) continue;
    for (let j = i + 1; j < categories.length; j++) {
      const cj = categories[j];
      if (!cj || cj === ci) continue;
      vals.push(cosineMatrix[i]![j]!);
    }
  }
  return mean(vals);
}

/** Fraction of points whose nearest neighbor shares the same category. */
export function nnCategoryAccuracy(
  cosineMatrix: number[][],
  categories: Array<string | null | undefined>,
): number | null {
  let ok = 0;
  let total = 0;
  const knn = knnFromCosineMatrix(cosineMatrix, 1);
  for (let i = 0; i < categories.length; i++) {
    const ci = categories[i];
    const nb = knn[i]?.[0];
    if (!ci || !nb) continue;
    total++;
    if (categories[nb.index] === ci) ok++;
  }
  return total ? ok / total : null;
}

/**
 * Mean silhouette using cosine distance d = 1 − cos.
 * Only points with a non-null category that appears at least twice contribute.
 */
export function silhouetteCosine(
  cosineMatrix: number[][],
  categories: Array<string | null | undefined>,
): number | null {
  const n = categories.length;
  const scores: number[] = [];
  for (let i = 0; i < n; i++) {
    const ci = categories[i];
    if (!ci) continue;
    const same: number[] = [];
    const otherByCat = new Map<string, number[]>();
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const cj = categories[j];
      if (!cj) continue;
      const d = 1 - cosineMatrix[i]![j]!;
      if (cj === ci) same.push(d);
      else {
        const arr = otherByCat.get(cj) ?? [];
        arr.push(d);
        otherByCat.set(cj, arr);
      }
    }
    if (!same.length || !otherByCat.size) continue;
    const a = mean(same)!;
    let b = Infinity;
    for (const arr of otherByCat.values()) {
      const m = mean(arr);
      if (m != null && m < b) b = m;
    }
    if (!Number.isFinite(b)) continue;
    const denom = Math.max(a, b);
    scores.push(denom < 1e-12 ? 0 : (b - a) / denom);
  }
  return mean(scores);
}

/**
 * Rough projection quality: for each point, fraction of its k original neighbors
 * that remain among its k nearest neighbors in the projected plane/space.
 */
export function projectionNeighborhoodRetention(
  cosineMatrix: number[][],
  positions: Array<{ x: number; y: number; z?: number }>,
  k = 3,
): number | null {
  const n = cosineMatrix.length;
  if (n < 3) return null;
  const kk = Math.min(k, n - 1);
  const orig = knnFromCosineMatrix(cosineMatrix, kk);
  let hit = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const proj: NeighborHit[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      proj.push({
        index: j,
        cosine: -projectedDistance(positions[i]!, positions[j]!), // sort by nearer = larger
      });
    }
    proj.sort((a, b) => b.cosine - a.cosine);
    const set = new Set(proj.slice(0, kk).map((x) => x.index));
    for (const nb of orig[i]!) {
      total++;
      if (set.has(nb.index)) hit++;
    }
  }
  return total ? hit / total : null;
}

/** Points whose nearest-neighbor cosine is below (mean − z * std) of the NN cosine distribution. */
export function findOutliers(
  cosineMatrix: number[][],
  zScore = 1.0,
): OutlierHit[] {
  const knn = knnFromCosineMatrix(cosineMatrix, 1);
  const nearest = knn.map((row, index) => ({
    index,
    nearestCosine: row[0]?.cosine ?? 0,
  }));
  const vals = nearest.map((x) => x.nearestCosine);
  const mu = mean(vals) ?? 0;
  const variance = mean(vals.map((v) => (v - mu) ** 2)) ?? 0;
  const std = Math.sqrt(variance);
  const threshold = std < 1e-9 ? mu - 0.05 : mu - zScore * std;
  return nearest
    .filter((x) => x.nearestCosine <= threshold)
    .sort((a, b) => a.nearestCosine - b.nearestCosine);
}

export function computeNeighborhoodMetrics(opts: {
  cosineMatrix: number[][];
  categories?: Array<string | null | undefined>;
  positions?: Array<{ x: number; y: number; z?: number }>;
  knnK?: number;
}): NeighborhoodMetrics {
  const cats = opts.categories ?? [];
  const knnK = opts.knnK ?? 3;
  const outliers = findOutliers(opts.cosineMatrix);
  return {
    withinGroupCosine: withinGroupCosine(opts.cosineMatrix, cats),
    betweenGroupCosine: betweenGroupCosine(opts.cosineMatrix, cats),
    nnCategoryAccuracy: nnCategoryAccuracy(opts.cosineMatrix, cats),
    silhouetteCosine: silhouetteCosine(opts.cosineMatrix, cats),
    projectionNeighborhoodRetention: opts.positions
      ? projectionNeighborhoodRetention(opts.cosineMatrix, opts.positions, knnK)
      : null,
    outlierIndices: outliers.map((o) => o.index),
  };
}
