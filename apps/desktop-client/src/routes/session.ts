/**
 * /api/session — LiveKit join tokens for iOS Talk (and status/end shims).
 */

import { isAgentInRoom, isLiveVoiceStack } from "@alfred/livekit";
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
  const live = isLiveVoiceStack();

  let agentPresent: boolean | null = null;
  if (configured) {
    if (live) {
      // GPT-Live joins on Talk dispatch into a fresh room — there is no always-on
      // participant in LIVEKIT_ROOM. Treat configured + live stack as "ready".
      agentPresent = true;
    } else {
      agentPresent = await isAgentInRoom({
        url: process.env.LIVEKIT_URL!,
        apiKey: process.env.LIVEKIT_API_KEY!,
        apiSecret: process.env.LIVEKIT_API_SECRET!,
        roomName: room,
        identity,
      });
    }
  }

  const agentHint = !configured
    ? "Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET on the Mac."
    : live
      ? null
      : agentPresent
        ? null
        : "Voice agent is offline — on the Mac run `make alfred` (or `pnpm voice`) and wait for LiveKit reconnect.";

  return c.json({
    ok: true,
    livekitConfigured: configured,
    room,
    agentPresent,
    // Only surface the live hint when something looks wrong; Talk treats
    // agentPresent=true as "ready" and suppresses the banner.
    agentHint: live && agentPresent ? null : agentHint,
    voiceStack: live ? "live" : "cascade",
  });
});

sessionRouter.post("/end", (c) => c.json({ ok: true }));
