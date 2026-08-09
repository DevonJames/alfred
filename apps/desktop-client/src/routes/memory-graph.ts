/**
 * Memory graph browser + JSON API
 *
 * GET /memory/graph          — interactive UI
 * GET /memory/graph/data     — nodes + links JSON
 * GET /memory/graph/node/:id — record detail + neighbors
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { loadMemoryGraph, loadMemoryRecordDetail } from "../lib/memory-graph.js";

export const memoryGraphRouter = new Hono();

const uiPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../ui/memory-graph.html",
);

memoryGraphRouter.get("/", async (c) => {
  const html = await readFile(uiPath, "utf8");
  return c.html(html);
});

memoryGraphRouter.get("/data", async (c) => {
  try {
    const artifacts = c.req.query("artifacts") === "1";
    const snapshot = await loadMemoryGraph({
      hideArtifacts: !artifacts,
      hideProvenanceEdges: true,
    });
    return c.json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "graph_load_failed", message }, 500);
  }
});

memoryGraphRouter.get("/node/:id", async (c) => {
  try {
    const id = decodeURIComponent(c.req.param("id"));
    const detail = await loadMemoryRecordDetail(id);
    if (!detail) return c.json({ error: "not_found", message: `No record ${id}` }, 404);
    return c.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "node_load_failed", message }, 500);
  }
});
