/**
 * LiveKit join token for the voice uplink UI (browser client).
 *
 * GET /api/token → { url, room, identity, token }
 *
 * Intentionally unauthenticated so the local /voice/ UI keeps working.
 * iOS should prefer POST/GET /api/session/token (device bearer required).
 */

import { Hono } from "hono";
import { mintLiveKitClientToken } from "../lib/livekit-token.js";

export const tokenRouter = new Hono();

tokenRouter.get("/token", async (c) => {
  const minted = await mintLiveKitClientToken("alfred-client");
  if (!minted.ok) {
    return c.json({ error: minted.error }, minted.status);
  }
  return c.json(minted.body);
});
