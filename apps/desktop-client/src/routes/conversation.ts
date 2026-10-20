/**
 * /api/conversation — text turn API.
 * Sidecar mode streams NDJSON tokens for alfred-home; desktop PIN path stays JSON.
 */

import { Hono } from "hono";
import {
  formatFitnessFocusPrompt,
  loadCurrentFitnessDayPlan,
  readFitnessFocus,
  speakFitnessPlan,
} from "@alfred/briefing";
import {
  cancelTextSession,
  conversationSessionKey,
  getTextSession,
  resetTextSession,
  setHomeDeviceToken,
} from "../lib/text-session.js";
import { formatTalkFocusSystem, readTalkFocus } from "@alfred/memory";
import { requireSidecarOrDevice } from "../middleware/sidecar-or-device.js";
import { isSidecarMode } from "../lib/sidecar-mode.js";
import type { DeviceRecord } from "../lib/device-store.js";

export const conversationRouter = new Hono<{ Variables: { device?: DeviceRecord } }>();

conversationRouter.use("*", requireSidecarOrDevice);

type TurnBody = {
  text?: string;
  sessionId?: string;
  sessionKey?: string;
  householdId?: string;
  targetAgentId?: string;
  channel?: "text" | "voice";
  systemExtras?: string | Record<string, unknown>;
  imageDataUrls?: string[];
  imageDataUrl?: string;
  interrupt?: boolean;
  deviceToken?: string;
  stream?: boolean;
};

function extrasToString(extras: TurnBody["systemExtras"]): string | undefined {
  if (!extras) return undefined;
  if (typeof extras === "string") return extras.trim() || undefined;
  try {
    const parts = Object.entries(extras)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => (typeof v === "string" ? `${k}:\n${v}` : `${k}:\n${JSON.stringify(v, null, 2)}`));
    return parts.length ? parts.join("\n\n") : undefined;
  } catch {
    return undefined;
  }
}

async function fitnessTurnContext(
  device: { id?: string; deviceType?: string | null } | undefined,
  clientExtras: string | undefined,
): Promise<string | undefined> {
  const blocks: string[] = [];
  if (device?.id && device.deviceType?.startsWith("fitnessally")) {
    const focus = await readFitnessFocus(device.id);
    if (focus) blocks.push(formatFitnessFocusPrompt(focus.card));
  }
  const timezone =
    process.env.BRIEFING_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const plan = await loadCurrentFitnessDayPlan(now, timezone);
  const spoken = speakFitnessPlan(plan, now, timezone);
  if (!spoken.startsWith("I don't")) {
    blocks.push(
      `Today's FitnessAlly plan. Use this only when the user asks what they are eating or training. Do not invent meals or workouts. ${spoken}`,
    );
  }
  if (clientExtras) blocks.push(clientExtras);
  const talkFocus = await readTalkFocus();
  if (talkFocus) blocks.push(formatTalkFocusSystem(talkFocus));
  return blocks.length ? blocks.join("\n\n") : undefined;
}

function sessionParts(body: TurnBody) {
  return {
    householdId: body.householdId,
    targetAgentId: body.targetAgentId,
    sessionKey: body.sessionKey ?? body.sessionId,
  };
}

function deliveredAssistantText(session: Awaited<ReturnType<typeof getTextSession>>): string {
  const snap = session.snapshot();
  const assistantTurn = [...snap.recentTurns].reverse().find((t) => t.role === "assistant");
  let deliveredText = assistantTurn?.text ?? "";
  if (snap.currentResponseId) {
    const ledger = session.getResponseLedger().snapshot(snap.currentResponseId);
    if (ledger?.deliveredText) deliveredText = ledger.deliveredText;
    else if (ledger?.committedText) deliveredText = ledger.committedText;
  }
  return deliveredText;
}

conversationRouter.post("/turn", async (c) => {
  let body: TurnBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const text = body.text?.trim();
  if (!text) {
    return c.json({ error: "text is required" }, 400);
  }

  const parts = sessionParts(body);
  const extraSystem = await fitnessTurnContext(c.get("device"), extrasToString(body.systemExtras));
  const imageDataUrls = [
    ...(body.imageDataUrls ?? []),
    ...(body.imageDataUrl ? [body.imageDataUrl] : []),
  ].filter(Boolean);
  const wantStream = isSidecarMode() || body.stream === true;

  try {
    if (body.interrupt) {
      await cancelTextSession(parts);
    }
    const session = await getTextSession(parts);
    setHomeDeviceToken(parts, body.deviceToken);

    if (!wantStream) {
      await session.handleUserUtterance({
        text,
        extraSystem,
        imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined,
      });
      const snap = session.snapshot();
      return c.json({
        sessionId: snap.sessionId,
        sessionKey: conversationSessionKey(parts),
        state: snap.state,
        assistantText: deliveredAssistantText(session),
        recentTurns: snap.recentTurns.slice(-12),
      });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (obj: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        };
        try {
          await session.handleUserUtterance({
            text,
            extraSystem,
            imageDataUrls: imageDataUrls.length ? imageDataUrls : undefined,
            onToken: (delta) => write({ type: "token", text: delta }),
          });
          const snap = session.snapshot();
          write({
            type: "done",
            sessionId: snap.sessionId,
            sessionKey: conversationSessionKey(parts),
            state: snap.state,
            assistantText: deliveredAssistantText(session),
          });
        } catch (err) {
          write({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

conversationRouter.post("/cancel", async (c) => {
  let body: TurnBody = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is ok
  }
  const cancelled = await cancelTextSession(sessionParts(body));
  return c.json({ ok: true, cancelled });
});

conversationRouter.post("/reset", async (c) => {
  let body: TurnBody = {};
  try {
    body = await c.req.json();
  } catch {
    // empty
  }
  await resetTextSession(sessionParts(body));
  return c.json({ ok: true, sessionKey: conversationSessionKey(sessionParts(body)) });
});

conversationRouter.get("/events", async (c) => {
  try {
    const parts = {
      householdId: c.req.query("householdId") ?? undefined,
      targetAgentId: c.req.query("targetAgentId") ?? undefined,
      sessionKey: c.req.query("sessionKey") ?? c.req.query("sessionId") ?? undefined,
    };
    const session = await getTextSession(parts);
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
