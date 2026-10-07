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
  digSpeechEngineNewsArticle,
  generateSilentTextReply,
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

/**
 * Dig into a headline from the last briefing/news rundown, then prime Speech Engine
 * so the next client user-message speaks the summary (Talk HUD headline clicks).
 * Body: { index?: number; match?: string; url?: string; title?: string }
 */
tokenRouter.post("/speech/news-dig", async (c) => {
  if (!isSpeechEngineStack()) {
    return c.json({ error: "News dig requires VOICE=live2." }, 503);
  }
  let body: { index?: unknown; match?: unknown; url?: unknown; title?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const index =
    typeof body.index === "number" && Number.isFinite(body.index)
      ? Math.max(1, Math.floor(body.index))
      : undefined;
  const match = typeof body.match === "string" ? body.match.trim() : undefined;
  const url = typeof body.url === "string" ? body.url.trim() : undefined;
  const title = typeof body.title === "string" ? body.title.trim() : undefined;
  if (index == null && !match && !url) {
    return c.json({ error: "index, match, or url is required" }, 400);
  }
  try {
    const { speech } = await digSpeechEngineNewsArticle({ index, match, url, title });
    return c.json({ ok: true, speech });
  } catch (err) {
    console.error("[speech] news-dig failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

/**
 * Typed chat turn without TTS (VOICE=live2 and local Talk composer).
 * Body: { text: string }
 */
tokenRouter.post("/speech/text-turn", async (c) => {
  let body: { text?: string };
  try {
    body = (await c.req.json()) as { text?: string };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text is required" }, 400);
  try {
    const assistantText = await generateSilentTextReply(text);
    return c.json({ assistantText, ok: true });
  } catch (err) {
    console.error("[speech] text-turn failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
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
