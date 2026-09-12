/**
 * Memory graph browser + JSON API
 *
 * GET /memory/graph          — interactive UI
 * GET /memory/graph/app.js   — local graph renderer (no CDN)
 * GET /memory/graph/date-query.js — date search normalization
 * GET /memory/graph/data     — nodes + links JSON
 * GET /memory/graph/node/:id — record detail + neighbors
 * GET /memory/graph/artifact/:id — image bytes for a stored artifact
 * POST /memory/graph/node/update — edit name/details/contact (id in body)
 * POST /memory/graph/node/delete — delete a record (id in body)
 * POST /memory/graph/node/set-self — mark a Person as the profile self (id in body)
 * POST /memory/graph/clean-index — merge duplicate entities (SSE progress + result)
 * GET  /memory/graph/embeddings — cached 3D embedding-space positions
 * POST /memory/graph/embeddings/rebuild — OpenAI embed + PCA (SSE progress + result)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  cleanMemoryIndex,
  deleteMemoryRecord,
  loadMemoryEmbeddings,
  loadMemoryGraph,
  loadMemoryRecordDetail,
  loadMemorySemanticMap,
  readMemoryArtifactBytes,
  rebuildMemoryEmbeddings,
  setMemorySelf,
  updateMemoryRecord,
} from "../lib/memory-graph.js";

export const memoryGraphRouter = new Hono();

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../ui");

function decodeNodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

memoryGraphRouter.get("/", async (c) => {
  const html = await readFile(path.join(uiDir, "memory-graph.html"), "utf8");
  // Bust script cache whenever the page is loaded.
  const stamped = html.replace(
    "/memory/graph/app.js",
    `/memory/graph/app.js?v=${Date.now()}`,
  );
  return c.html(stamped);
});

memoryGraphRouter.get("/app.js", async (c) => {
  const js = await readFile(path.join(uiDir, "memory-graph.js"), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
});

memoryGraphRouter.get("/date-query.js", async (c) => {
  const js = await readFile(path.join(uiDir, "date-query.js"), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
});

memoryGraphRouter.get("/data", async (c) => {
  try {
    const artifacts = c.req.query("artifacts") === "1";
    const forceRebuild = c.req.query("rebuild") === "1";
    const snapshot = await loadMemoryGraph({
      hideArtifacts: !artifacts,
      hideProvenanceEdges: true,
      forceRebuild,
    });
    return c.json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "graph_load_failed", message }, 500);
  }
});

memoryGraphRouter.get("/artifact/:id", async (c) => {
  try {
    const id = decodeNodeId(c.req.param("id"));
    const file = await readMemoryArtifactBytes(id);
    if (!file) return c.json({ error: "not_found", message: `No file artifact ${id}` }, 404);
    const safeName = file.filename.replace(/[\r\n"]/g, "");
    return c.body(file.bytes, 200, {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, max-age=3600",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "artifact_load_failed", message }, 500);
  }
});

memoryGraphRouter.get("/node/:id", async (c) => {
  try {
    const id = decodeNodeId(c.req.param("id"));
    const detail = await loadMemoryRecordDetail(id);
    if (!detail) return c.json({ error: "not_found", message: `No record ${id}` }, 404);
    return c.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "node_load_failed", message }, 500);
  }
});

/** Prefer body id — path params with did:memory:… can confuse routers. */
memoryGraphRouter.post("/node/update", async (c) => {
  try {
    const body = await c.req.json<{
      id?: string;
      name?: string;
      text?: string;
      summary?: string;
      email?: string | null;
      telephone?: string | null;
      birthDate?: string | null;
    }>();
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return c.json({ error: "missing_id", message: "id is required" }, 400);
    const detail = await updateMemoryRecord(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      text: typeof body.text === "string" ? body.text : undefined,
      summary: typeof body.summary === "string" ? body.summary : undefined,
      email:
        body.email === null
          ? null
          : typeof body.email === "string"
            ? body.email
            : undefined,
      telephone:
        body.telephone === null
          ? null
          : typeof body.telephone === "string"
            ? body.telephone
            : undefined,
      birthDate:
        body.birthDate === null
          ? null
          : typeof body.birthDate === "string"
            ? body.birthDate
            : undefined,
    });
    if (!detail) return c.json({ error: "not_found", message: `No record ${id}` }, 404);
    return c.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "node_update_failed", message }, 500);
  }
});

memoryGraphRouter.post("/node/delete", async (c) => {
  try {
    const body = await c.req.json<{ id?: string }>();
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return c.json({ error: "missing_id", message: "id is required" }, 400);
    const result = await deleteMemoryRecord(id);
    if (!result) return c.json({ error: "not_found", message: `No record ${id}` }, 404);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "node_delete_failed", message }, 500);
  }
});

memoryGraphRouter.post("/node/set-self", async (c) => {
  try {
    const body = await c.req.json<{ id?: string }>();
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return c.json({ error: "missing_id", message: "id is required" }, 400);
    const result = await setMemorySelf(id);
    if (!result) return c.json({ error: "not_found", message: `No record ${id}` }, 404);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /Only Person|Not an Entity|Missing revision/i.test(message) ? 400 : 500;
    return c.json({ error: "set_self_failed", message }, status);
  }
});

memoryGraphRouter.post("/clean-index", (c) => {
  return streamSSE(c, async (stream) => {
    try {
      const result = await cleanMemoryIndex(undefined, async (progress) => {
        await stream.writeSSE({
          event: "progress",
          data: JSON.stringify(progress),
        });
      });
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify(result),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "clean_index_failed", message }),
      });
    }
  });
});

memoryGraphRouter.get("/embeddings", async (c) => {
  try {
    const snapshot = await loadMemoryEmbeddings();
    return c.json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "embeddings_load_failed", message }, 500);
  }
});

memoryGraphRouter.post("/embeddings/semantic-map", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      nodeIds?: unknown;
      categories?: unknown;
      method?: unknown;
      dims?: unknown;
      knnK?: unknown;
    };
    const nodeIds = Array.isArray(body.nodeIds)
      ? body.nodeIds.filter((id): id is string => typeof id === "string" && !!id.trim())
      : [];
    const categories = Array.isArray(body.categories)
      ? body.categories.map((c) => (typeof c === "string" ? c : null))
      : undefined;
    const method =
      body.method === "pca" || body.method === "directional-pca" || body.method === "mds-cosine"
        ? body.method
        : "mds-cosine";
    const dims = body.dims === 3 ? 3 : 2;
    const knnK = Math.max(1, Math.min(12, Number(body.knnK) || 3));

    const result = await loadMemorySemanticMap({
      nodeIds,
      categories,
      method,
      dims,
      knnK,
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "semantic_map_failed", message }, 500);
  }
});

memoryGraphRouter.post("/embeddings/rebuild", (c) => {
  return streamSSE(c, async (stream) => {
    try {
      const result = await rebuildMemoryEmbeddings(undefined, async (progress) => {
        await stream.writeSSE({
          event: "progress",
          data: JSON.stringify(progress),
        });
      });
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify(result),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: "embeddings_rebuild_failed", message }),
      });
    }
  });
});

memoryGraphRouter.delete("/node/:id", async (c) => {
  try {
    const id = decodeNodeId(c.req.param("id"));
    const result = await deleteMemoryRecord(id);
    if (!result) return c.json({ error: "not_found", message: `No record ${id}` }, 404);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "node_delete_failed", message }, 500);
  }
});

memoryGraphRouter.patch("/node/:id", async (c) => {
  try {
    const id = decodeNodeId(c.req.param("id"));
    const body = await c.req.json<{
      name?: string;
      text?: string;
      summary?: string;
      email?: string | null;
      telephone?: string | null;
      birthDate?: string | null;
    }>();
    const detail = await updateMemoryRecord(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      text: typeof body.text === "string" ? body.text : undefined,
      summary: typeof body.summary === "string" ? body.summary : undefined,
      email:
        body.email === null
          ? null
          : typeof body.email === "string"
            ? body.email
            : undefined,
      telephone:
        body.telephone === null
          ? null
          : typeof body.telephone === "string"
            ? body.telephone
            : undefined,
      birthDate:
        body.birthDate === null
          ? null
          : typeof body.birthDate === "string"
            ? body.birthDate
            : undefined,
    });
    if (!detail) return c.json({ error: "not_found", message: `No record ${id}` }, 404);
    return c.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "node_update_failed", message }, 500);
  }
});
