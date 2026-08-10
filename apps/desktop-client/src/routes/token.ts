/**
 * LiveKit join token for the voice uplink UI (browser client).
 *
 * GET /api/token → { url, room, identity, token }
 */

import { createLiveKitToken } from "@alfred/livekit";
import { Hono } from "hono";

export const tokenRouter = new Hono();

tokenRouter.get("/token", async (c) => {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return c.json(
      {
        error: "Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in the repo .env",
      },
      500,
    );
  }

  const room = process.env.LIVEKIT_ROOM ?? "alfred-dev";
  const identity = `alfred-client-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const token = await createLiveKitToken({
      apiKey,
      apiSecret,
      roomName: room,
      identity,
    });
    return c.json({ url, room, identity, token });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
