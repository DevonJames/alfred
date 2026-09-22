/**
 * /api/session — LiveKit join tokens for iOS Talk and AlfredBot (and status/end shims).
 */

import { isAgentInRoom, isLiveVoiceStack } from "@alfred/livekit";
import { isSpeechEngineStack, speechEngineReady } from "../lib/speech-engine.js";
import { Hono } from "hono";
import { endLiveConversation } from "../lib/livekit-session-end.js";
import { livekitConfigured, mintLiveKitClientToken } from "../lib/livekit-token.js";
import { isRobotConversation, robotConversationId } from "../lib/robot-conversation.js";
import { requireDevice } from "../middleware/require-device.js";

export const sessionRouter = new Hono();

sessionRouter.use("*", requireDevice);

function parseDispatchFlag(raw: unknown): boolean | undefined {
  if (raw === false || raw === "false" || raw === "0") return false;
  if (raw === true || raw === "true" || raw === "1") return true;
  return undefined;
}

async function readTokenRequest(c: {
  req: { query: (name: string) => string | undefined; json: () => Promise<unknown> };
}): Promise<{ client?: string; join?: string; dispatch?: boolean }> {
  const queryClient = c.req.query("client");
  const queryJoin = c.req.query("join");
  const queryDispatch = parseDispatchFlag(c.req.query("dispatch"));
  try {
    const body = (await c.req.json()) as { client?: string; join?: string; dispatch?: unknown };
    return {
      client: typeof body.client === "string" ? body.client : queryClient,
      join: typeof body.join === "string" ? body.join : queryJoin,
      dispatch: parseDispatchFlag(body.dispatch) ?? queryDispatch,
    };
  } catch {
    return { client: queryClient, join: queryJoin, dispatch: queryDispatch };
  }
}

sessionRouter.get("/token", async (c) => {
  if (isSpeechEngineStack()) {
    return c.json(
      {
        error:
          "VOICE=live2 is desktop Talk only (open /voice/ on this Mac). iOS still uses cascade or make alfred VOICE=live.",
        voiceStack: "live2",
      },
      501,
    );
  }
  const minted = await mintLiveKitClientToken({
    client: c.req.query("client"),
    join: c.req.query("join"),
    dispatch: parseDispatchFlag(c.req.query("dispatch")),
  });
  if (!minted.ok) {
    return c.json({ error: minted.error }, minted.status);
  }
  return c.json(minted.body);
});

sessionRouter.post("/token", async (c) => {
  if (isSpeechEngineStack()) {
    return c.json(
      {
        error:
          "VOICE=live2 is desktop Talk only (open /voice/ on this Mac). iOS still uses cascade or make alfred VOICE=live.",
        voiceStack: "live2",
      },
      501,
    );
  }
  const minted = await mintLiveKitClientToken(await readTokenRequest(c));
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
  const live2 = isSpeechEngineStack();

  let agentPresent: boolean | null = null;
  if (live2) {
    agentPresent = speechEngineReady();
  } else if (configured) {
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

  const agentHint = live2
    ? speechEngineReady()
      ? "ElevenLabs Speech Engine is on desktop Talk (/voice/). Phone Talk still uses cascade or VOICE=live."
      : "Speech Engine is not attached. Set ELEVENLABS_SPEECH_ENGINE_ID and a public wss URL, then restart."
    : !configured
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
    voiceStack: live2 ? "live2" : live ? "live" : "cascade",
    conversation: isRobotConversation(),
    conversationId: robotConversationId(),
  });
});

sessionRouter.post("/end", async (c) => {
  let sessionId: string | undefined;
  try {
    const body = (await c.req.json()) as { sessionId?: unknown };
    if (typeof body.sessionId === "string") sessionId = body.sessionId;
  } catch {
    /* empty body is a valid hangup */
  }
  await endLiveConversation(sessionId);
  return c.json({ ok: true, ended: true });
});
