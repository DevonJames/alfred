/**
 * /api/conversation — text turn shim for iOS Talk fallback.
 * Voice audio still uses LiveKit via /api/session/token + pnpm voice.
 */

import { Hono } from "hono";
import { getTextSession } from "../lib/text-session.js";
import { requireDevice } from "../middleware/require-device.js";

export const conversationRouter = new Hono();

conversationRouter.use("*", requireDevice);

conversationRouter.post("/turn", async (c) => {
  let body: { text?: string; sessionId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const text = body.text?.trim();
  if (!text) {
    return c.json({ error: "text is required" }, 400);
  }

  try {
    const session = await getTextSession();
    const before = (await session.getEvents()).length;
    await session.handleUserUtterance({ text });
    const snap = session.snapshot();
    const events = await session.getEvents();
    const newEvents = events.slice(before);

    const assistantTurn = [...snap.recentTurns]
      .reverse()
      .find((t) => t.role === "assistant");

    let deliveredText = assistantTurn?.text ?? "";
    if (snap.currentResponseId) {
      const ledger = session.getResponseLedger().snapshot(snap.currentResponseId);
      if (ledger?.deliveredText) {
        deliveredText = ledger.deliveredText;
      } else if (ledger?.committedText) {
        deliveredText = ledger.committedText;
      }
    }

    return c.json({
      sessionId: snap.sessionId,
      state: snap.state,
      assistantText: deliveredText,
      recentTurns: snap.recentTurns.slice(-12),
      events: newEvents,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

conversationRouter.get("/events", async (c) => {
  try {
    const session = await getTextSession();
    const afterRaw = c.req.query("after");
    const after = afterRaw != null && afterRaw !== "" ? Number(afterRaw) : -1;
    const events = await session.getEvents();
    const filtered =
      Number.isFinite(after) && after >= 0
        ? events.filter((e) => e.sequence > after)
        : events;
    const snap = session.snapshot();
    return c.json({
      sessionId: snap.sessionId,
      state: snap.state,
      events: filtered,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
