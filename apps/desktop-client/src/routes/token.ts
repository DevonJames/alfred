/**
 * LiveKit join token for the voice uplink UI (browser client).
 *
 * GET /api/token → { url, room, identity, token }
 * POST /api/token/end → { ok, ended } — delete ephemeral GPT-Live room (Stop)
 *
 * Intentionally unauthenticated so the local /voice/ UI keeps working.
 * iOS should prefer POST/GET /api/session/token (device bearer required).
 */

import { Hono } from "hono";
import { endLiveConversation } from "../lib/livekit-session-end.js";
import { mintLiveKitClientToken } from "../lib/livekit-token.js";

export const tokenRouter = new Hono();

tokenRouter.get("/token", async (c) => {
  const minted = await mintLiveKitClientToken({ client: "web" });
  if (!minted.ok) {
    return c.json({ error: minted.error }, minted.status);
  }
  return c.json(minted.body);
});

/** Desktop Talk Stop — same room delete as iOS POST /api/session/end. */
tokenRouter.post("/token/end", async (c) => {
  let sessionId: string | undefined;
  try {
    const body = (await c.req.json()) as { sessionId?: unknown; room?: unknown };
    if (typeof body.sessionId === "string") sessionId = body.sessionId;
    else if (typeof body.room === "string") sessionId = body.room;
  } catch {
    /* empty body still clears robot conversation flag */
  }
  await endLiveConversation(sessionId);
  return c.json({ ok: true, ended: true });
});
