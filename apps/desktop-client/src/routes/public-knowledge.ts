import { Hono } from "hono";
import {
  discoverPublicCandidates,
  indexPublicUrl,
} from "../lib/public-knowledge.js";
import { requireSidecarOrDevice } from "../middleware/sidecar-or-device.js";

export const publicKnowledgeRouter = new Hono();

publicKnowledgeRouter.use("*", requireSidecarOrDevice);

/** POST /api/public-knowledge/discover */
publicKnowledgeRouter.post("/discover", async (c) => {
  let body: { limit?: number } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* empty ok */
  }
  const limit = typeof body.limit === "number" ? body.limit : 5;
  try {
    return c.json(await discoverPublicCandidates(limit));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

/** POST /api/public-knowledge/index */
publicKnowledgeRouter.post("/index", async (c) => {
  let body: { url?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const url = body.url?.trim();
  if (!url) return c.json({ error: "url is required" }, 400);
  try {
    return c.json(await indexPublicUrl(url));
  } catch (err) {
    const status = (err as { status?: number }).status === 400 ? 400 : 500;
    return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
  }
});

/**
 * POST /api/public-knowledge/publish
 * Publishing private memory to a public network is intentionally disabled in MVP.
 */
publicKnowledgeRouter.post("/publish", async (c) => {
  let body: { memoryId?: string; confirm?: boolean } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (body.confirm !== true) {
    return c.json({ error: "confirm: true is required", published: false }, 400);
  }
  return c.json(
    {
      published: false,
      error: "Public publish is not enabled. Keep recommendations private with Keep this.",
    },
    403,
  );
});
