/**
 * /api/session — LiveKit join tokens for iOS Talk (and status/end shims).
 */

import { isAgentInRoom } from "@alfred/livekit";
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

sessionRouter.get("/status", async (c) => {
  const room = process.env.LIVEKIT_ROOM ?? "alfred-dev";
  const identity = process.env.LIVEKIT_IDENTITY ?? "alfred-agent";
  const configured = livekitConfigured();

  let agentPresent: boolean | null = null;
  if (configured) {
    agentPresent = await isAgentInRoom({
      url: process.env.LIVEKIT_URL!,
      apiKey: process.env.LIVEKIT_API_KEY!,
      apiSecret: process.env.LIVEKIT_API_SECRET!,
      roomName: room,
      identity,
    });
  }

  const agentHint = !configured
    ? "Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET on the Mac."
    : agentPresent
      ? null
      : "Voice agent is offline — on the Mac run `make alfred` (or `pnpm voice`) and wait for LiveKit reconnect.";

  return c.json({
    ok: true,
    livekitConfigured: configured,
    room,
    agentPresent,
    agentHint,
  });
});

sessionRouter.post("/end", (c) => c.json({ ok: true }));
