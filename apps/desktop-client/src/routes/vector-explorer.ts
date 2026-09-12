/**
 * Vector Explorer — session-only embedding demos (not written to memory).
 *
 * GET  /vector-explorer                 — UI
 * GET  /vector-explorer/app.js
 * GET  /vector-explorer/vendor/*        — shared Three.js stack
 * GET  /vector-explorer/datasets        — synthetic demo metadata + texts
 * POST /vector-explorer/embed           — embed + project (vectors or semantic map)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  CATEGORY_LABELS,
  DEMO_DATASETS,
  computeNeighborhoodMetrics,
  embeddingModelFromEnv,
  getDemoDataset,
  knnFromCosineMatrix,
  openaiApiKey,
  openaiEmbedTexts,
  pairwiseCosineMatrix,
  projectCosineMds,
  projectEmbeddingsDirectional,
  projectEmbeddingsPca,
  projectedDistance,
} from "@alfred/memory";

export const vectorExplorerRouter = new Hono();

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../ui");
const vendorDir = path.join(uiDir, "vendor");

const VENDOR_FILES = new Set([
  "three.min.js",
  "3d-force-graph.min.js",
  "CopyShader.js",
  "LuminosityHighPassShader.js",
  "EffectComposer.js",
  "ShaderPass.js",
  "RenderPass.js",
  "UnrealBloomPass.js",
]);

const MAX_TEXTS = 80;

vectorExplorerRouter.get("/", async (c) => {
  const html = await readFile(path.join(uiDir, "vector-explorer.html"), "utf8");
  const stamped = html.replace(
    "/vector-explorer/app.js",
    `/vector-explorer/app.js?v=${Date.now()}`,
  );
  return c.html(stamped);
});

vectorExplorerRouter.get("/app.js", async (c) => {
  const js = await readFile(path.join(uiDir, "vector-explorer.js"), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
});

vectorExplorerRouter.get("/vendor/:file", async (c) => {
  const file = c.req.param("file");
  if (!VENDOR_FILES.has(file)) {
    return c.json({ error: "not_found" }, 404);
  }
  const js = await readFile(path.join(vendorDir, file), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
  });
});

vectorExplorerRouter.get("/datasets", (c) => {
  return c.json({
    categoryLabels: CATEGORY_LABELS,
    datasets: DEMO_DATASETS.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      count: d.observations.length,
      hasTimestamps: d.observations.some((o) => !!o.timestamp),
      observations: d.observations.map((o) => ({
        id: o.id,
        text: o.text,
        category: o.category,
        timestamp: o.timestamp ?? null,
      })),
    })),
  });
});

vectorExplorerRouter.post("/embed", async (c) => {
  try {
    if (!openaiApiKey()) {
      return c.json(
        {
          error: "missing_api_key",
          message: "OPENAI_API_KEY is required for Vector Explorer",
        },
        400,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      texts?: unknown;
      datasetId?: unknown;
      view?: unknown;
      projectionMethod?: unknown;
      projectionDims?: unknown;
      knnK?: unknown;
    };

    const view = body.view === "vectors" ? "vectors" : "semantic-map";
    const projectionDims = body.projectionDims === 3 ? 3 : 2;
    const knnK = Math.max(1, Math.min(10, Number(body.knnK) || 3));

    let texts: string[] = [];
    let categories: Array<string | null> = [];
    let timestamps: Array<string | null> = [];
    let labels: string[] = [];
    let sourceIds: string[] = [];

    if (typeof body.datasetId === "string" && body.datasetId.trim()) {
      const ds = getDemoDataset(body.datasetId.trim());
      if (!ds) {
        return c.json({ error: "unknown_dataset", message: `Unknown dataset ${body.datasetId}` }, 400);
      }
      texts = ds.observations.map((o) => o.text);
      categories = ds.observations.map((o) => o.category);
      timestamps = ds.observations.map((o) => o.timestamp ?? null);
      labels = ds.observations.map((o) => o.id);
      sourceIds = ds.observations.map((o) => o.id);
    } else {
      const raw = Array.isArray(body.texts) ? body.texts : [];
      texts = raw
        .map((t: unknown) => (typeof t === "string" ? t.trim() : ""))
        .filter((t: string): t is string => Boolean(t))
        .slice(0, MAX_TEXTS);
      categories = texts.map(() => null);
      timestamps = texts.map(() => null);
      labels = texts.map((_, i) => `Ex ${i + 1}`);
      sourceIds = texts.map((_, i) => `ex-${i + 1}`);
    }

    if (texts.length < 2) {
      return c.json(
        {
          error: "too_few",
          message: "Enter at least 2 non-empty texts (or load a demo dataset).",
        },
        400,
      );
    }
    if (texts.length > MAX_TEXTS) {
      return c.json(
        { error: "too_many", message: `At most ${MAX_TEXTS} texts per session.` },
        400,
      );
    }

    const model = embeddingModelFromEnv();
    // Categories / timestamps are NEVER sent to the embedding API.
    const embeddings = await openaiEmbedTexts(texts, { model });
    const cosineMatrix = pairwiseCosineMatrix(embeddings);
    const ids = sourceIds;

    let method: string;
    let disclaimer: string;
    let positions: Record<string, { x: number; y: number; z: number }>;

    if (view === "vectors") {
      const projection = projectEmbeddingsDirectional(ids, embeddings, 220);
      method = projection.method;
      positions = projection.positions;
      disclaimer =
        "Directional PCA on unit vectors. Arrows show absolute direction from the origin in a lossy 3D projection — original cosine similarities remain authoritative.";
    } else {
      const requested =
        body.projectionMethod === "pca"
          ? "pca"
          : body.projectionMethod === "directional-pca"
            ? "directional-pca"
            : "mds-cosine";

      if (requested === "mds-cosine") {
        const projection = projectCosineMds(ids, cosineMatrix, projectionDims, 280);
        method = projection.method;
        positions = projection.positions;
        if (projectionDims === 2) {
          for (const id of ids) {
            const p = positions[id];
            if (p) p.z = 0;
          }
        }
        disclaimer = projection.disclaimer;
      } else if (requested === "directional-pca") {
        const projection = projectEmbeddingsDirectional(ids, embeddings, 280);
        method = projection.method;
        positions = projection.positions;
        if (projectionDims === 2) {
          for (const id of ids) {
            const p = positions[id];
            if (p) p.z = 0;
          }
        }
        disclaimer =
          "Directional PCA is a lossy projection. Prefer MDS (cosine distance) for neighborhood demos. Original cosines remain authoritative.";
      } else {
        const projection = projectEmbeddingsPca(ids, embeddings, 280);
        method = projection.method;
        positions = projection.positions;
        if (projectionDims === 2) {
          for (const id of ids) {
            const p = positions[id];
            if (p) p.z = 0;
          }
        }
        disclaimer =
          "Centered PCA is a lossy projection optimized for variance, not local neighborhoods. Original cosines remain authoritative.";
      }
    }

    const posList = ids.map((id) => positions[id] ?? { x: 0, y: 0, z: 0 });
    const knn = knnFromCosineMatrix(cosineMatrix, knnK);
    const metrics = computeNeighborhoodMetrics({
      cosineMatrix,
      categories,
      positions: posList,
      knnK,
    });

    const points = texts.map((text, i) => {
      const id = ids[i]!;
      const pos = positions[id] ?? { x: 0, y: 0, z: 0 };
      const neighbors = (knn[i] ?? []).map((nb) => ({
        index: nb.index + 1,
        id: ids[nb.index]!,
        label: labels[nb.index]!,
        cosine: Number(nb.cosine.toFixed(4)),
        projectedDistance: Number(
          projectedDistance(pos, posList[nb.index]!).toFixed(2),
        ),
      }));
      return {
        id,
        index: i + 1,
        label: labels[i]!,
        text,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        category: categories[i],
        categoryLabel: categories[i] ? CATEGORY_LABELS[categories[i]!] ?? categories[i] : null,
        timestamp: timestamps[i],
        neighbors,
        isOutlier: metrics.outlierIndices.includes(i),
      };
    });

    const pairwise: Array<{ a: number; b: number; cosine: number }> = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        pairwise.push({
          a: i + 1,
          b: j + 1,
          cosine: Number(cosineMatrix[i]![j]!.toFixed(4)),
        });
      }
    }
    pairwise.sort((x, y) => y.cosine - x.cosine);

    return c.json({
      model,
      dimensions: embeddings[0]?.length ?? 0,
      view,
      projection: {
        method,
        dims: view === "vectors" ? 3 : projectionDims,
        disclaimer,
      },
      sessionOnly: true,
      generatedAt: new Date().toISOString(),
      knnK,
      points,
      cosineMatrix: cosineMatrix.map((row) => row.map((v) => Number(v.toFixed(4)))),
      pairwise,
      metrics: {
        withinGroupCosine: metrics.withinGroupCosine,
        betweenGroupCosine: metrics.betweenGroupCosine,
        nnCategoryAccuracy: metrics.nnCategoryAccuracy,
        silhouetteCosine: metrics.silhouetteCosine,
        projectionNeighborhoodRetention: metrics.projectionNeighborhoodRetention,
        outlierCount: metrics.outlierIndices.length,
      },
      categoryLabels: CATEGORY_LABELS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "embed_failed", message }, 500);
  }
});
