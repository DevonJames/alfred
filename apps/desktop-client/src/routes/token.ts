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
import {
  hushSpeechEngineReplies,
  isSpeechEngineStack,
  mintSpeechEngineConversationToken,
} from "../lib/speech-engine.js";

export const tokenRouter = new Hono();

tokenRouter.get("/token", async (c) => {
  if (isSpeechEngineStack()) {
    const minted = await mintSpeechEngineConversationToken();
    if (!minted.ok) return c.json({ error: minted.error, voiceStack: "live2" }, minted.status);
    return c.json(minted.body);
  }
  const minted = await mintLiveKitClientToken({ client: "web" });
  if (!minted.ok) {
    return c.json({ error: minted.error }, minted.status);
  }
  return c.json(minted.body);
});

/** Shhh on VOICE=live2 — stop the reply in progress. The session stays open. */
tokenRouter.post("/speech/hush", async (c) => {
  await hushSpeechEngineReplies();
  return c.json({ ok: true });
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
