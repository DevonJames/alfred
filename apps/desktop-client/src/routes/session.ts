/**
 * /api/session — LiveKit join tokens for iOS Talk (and status/end shims).
 */

import { Hono } from "hono";
import { livekitConfigured, mintLiveKitClientToken } from "../lib/livekit-token.js";
import { requireDevice } from "../middleware/require-device.js";

export const sessionRouter = new Hono();

sessionRouter.use("*", requireDevice);

sessionRouter.get("/token", async (c) => {
  const minted = await mintLiveKitClientToken("alfred-ios");
  if (!minted.ok) {
    return c.json({ error: minted.error }, minted.status);
  }
  return c.json(minted.body);
});

sessionRouter.post("/token", async (c) => {
  const minted = await mintLiveKitClientToken("alfred-ios");
  if (!minted.ok) {
    return c.json({ error: minted.error }, minted.status);
  }
  return c.json(minted.body);
});

sessionRouter.get("/status", (c) => {
  const room = process.env.LIVEKIT_ROOM ?? "alfred-dev";
  return c.json({
    ok: true,
    livekitConfigured: livekitConfigured(),
    room,
    agentHint: "Run `pnpm voice` on the Mac so alfred-agent joins the LiveKit room.",
  });
});

sessionRouter.post("/end", (c) => c.json({ ok: true }));
