/**
 * ALFRED experimental GPT-Live voice agent (LiveKit Agents + OpenAI GPT-Live-1).
 *
 * Separate from the cascade stack (Deepgram → Terra → ElevenLabs).
 * Voice: Ripple by default (custom Alfred clone later via OpenAI).
 *
 * Usage:
 *   1. OPENAI_API_KEY with GPT-Live alpha access + LIVEKIT_* in .env
 *   2. pnpm voice:live   (or: make alfred VOICE=live)
 *   3. Desktop/iOS mint tokens with ALFRED_VOICE_STACK=live — each Talk gets a
 *      fresh room + agent dispatch so the job ends when the client leaves.
 *
 * Do not run pnpm voice and pnpm voice:live against the same room at once.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type JobContext,
  type JobRequest,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import {
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type Room,
  type TrackPublication,
} from "@livekit/rtc-node";
import * as openai from "@livekit/agents-plugin-openai";
import { createAlfredBrain } from "./brain.js";
import { handleLiveControlPayload } from "./live/control.js";
import { buildLiveBackendInstructions, buildLiveVoiceInstructions } from "./live/instructions.js";
import { createAlfredLiveTools } from "./live/tools.js";
import { createRoomUiTranscriptPublisher } from "./live/ui-transcripts.js";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

export const LIVE_AGENT_NAME = process.env.LIVEKIT_AGENT_NAME?.trim() || "alfred-live";
const LIVE_IDENTITY = process.env.LIVEKIT_IDENTITY?.trim() || "alfred-agent";
const LIVE_VOICE = process.env.ALFRED_GPT_LIVE_VOICE?.trim() || "ripple";
const BACKEND_MODEL = process.env.ALFRED_GPT_LIVE_BACKEND_MODEL?.trim() || "gpt-5.6-luna";

/** GPT-Live caps each appendThinking/appendCommentary at 500 tokens. */
const MAX_APPEND_CHARS = 1_800;

function isPhoneIdentity(identity: string): boolean {
  return identity.startsWith("alfred-ios");
}

function isRobotIdentity(identity: string): boolean {
  return identity.startsWith("alfred-robot");
}

/** Desktop Talk uplink (`/voice/` → GET /api/token with client=web). */
function isWebIdentity(identity: string): boolean {
  return identity.startsWith("alfred-client");
}

function isTalkingIdentity(identity: string): boolean {
  return isPhoneIdentity(identity) || isWebIdentity(identity) || isRobotIdentity(identity);
}

function isRobotLiveRoom(name: string | undefined | null): boolean {
  return (name ?? "").startsWith("alfred-bot-");
}

function phonesInRoom(room: Room): RemoteParticipant[] {
  return [...room.remoteParticipants.values()].filter((p) => isPhoneIdentity(p.identity));
}

function talkingPeers(room: Room): RemoteParticipant[] {
  return [...room.remoteParticipants.values()].filter((p) => isTalkingIdentity(p.identity));
}

function subscribeAudio(publication: TrackPublication): void {
  const pub = publication as TrackPublication & { setSubscribed?: (v: boolean) => void };
  pub.setSubscribed?.(true);
}

function phoneHasSubscribedMic(participant: RemoteParticipant): boolean {
  for (const publication of participant.trackPublications.values()) {
    if (publication.kind === TrackKind.KIND_AUDIO && publication.track) return true;
  }
  return false;
}

function requestPhoneAudio(participant: RemoteParticipant): void {
  for (const publication of participant.trackPublications.values()) {
    if (publication.kind === TrackKind.KIND_AUDIO) subscribeAudio(publication);
  }
}

/** Prefer a live mic — phone, then desktop web, then AlfredBot. */
function pickTalkingPhone(room: Room): RemoteParticipant | undefined {
  const peers = talkingPeers(room);
  const phones = peers.filter((p) => isPhoneIdentity(p.identity));
  const webs = peers.filter((p) => isWebIdentity(p.identity));
  const robots = peers.filter((p) => isRobotIdentity(p.identity));
  const withPub = (list: RemoteParticipant[]) =>
    list.find((p) =>
      [...p.trackPublications.values()].some((pub) => pub.kind === TrackKind.KIND_AUDIO),
    );
  return (
    phones.find(phoneHasSubscribedMic) ??
    webs.find(phoneHasSubscribedMic) ??
    robots.find(phoneHasSubscribedMic) ??
    withPub(phones) ??
    withPub(webs) ??
    withPub(robots) ??
    phones.at(-1) ??
    webs.at(-1) ??
    robots.at(-1)
  );
}

/**
 * GPT-Live dies if we bind before the mic track is subscribed. Wait for a
 * live Talk peer: iPhone, desktop web, or AlfredBot.
 */
async function waitForTalkingPhone(room: Room, timeoutMs = 30_000): Promise<string | undefined> {
  const ready = (): string | undefined => {
    for (const peer of talkingPeers(room)) {
      requestPhoneAudio(peer);
      if (phoneHasSubscribedMic(peer)) return peer.identity;
    }
    return undefined;
  };
  const existing = ready();
  if (existing) return existing;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(pickTalkingPhone(room)?.identity);
    }, timeoutMs);

    const settleIfReady = () => {
      const identity = ready();
      if (!identity) return;
      cleanup();
      resolve(identity);
    };

    const onPublished = (publication: TrackPublication, participant: RemoteParticipant) => {
      if (!isTalkingIdentity(participant.identity)) return;
      if (publication.kind === TrackKind.KIND_AUDIO) subscribeAudio(publication);
      settleIfReady();
    };

    const cleanup = () => {
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantConnected, settleIfReady);
      room.off(RoomEvent.TrackPublished, onPublished);
      room.off(RoomEvent.TrackSubscribed, settleIfReady);
    };

    room.on(RoomEvent.ParticipantConnected, settleIfReady);
    room.on(RoomEvent.TrackPublished, onPublished);
    room.on(RoomEvent.TrackSubscribed, settleIfReady);
  });
}

/** Cover a Talk remount flicker. Hangup deletes the room; this is only a backup. */
const PHONE_LEAVE_GRACE_MS = 400;

/**
 * Robot stays in the shared room with no mic. When the phone leaves, wait a
 * short grace then end GPT-Live — do not burn session minutes waiting.
 */
function watchRobotPhone(
  room: Room,
  session: voice.AgentSession,
  initialIdentity: string,
  onPhoneGone: () => void,
): void {
  let current = initialIdentity;
  let grace: ReturnType<typeof setTimeout> | null = null;

  const cancelGrace = () => {
    if (!grace) return;
    clearTimeout(grace);
    grace = null;
  };

  const link = (identity: string) => {
    cancelGrace();
    if (!identity || identity === current) return;
    current = identity;
    session._roomIO?.setParticipant(identity);
    console.log(`[voice:live] rebound input to ${identity}`);
  };

  room.on(RoomEvent.TrackPublished, (publication, participant) => {
    if (!isTalkingIdentity(participant.identity)) return;
    if (publication.kind !== TrackKind.KIND_AUDIO) return;
    subscribeAudio(publication);
  });

  room.on(RoomEvent.TrackSubscribed, (_track, publication, participant) => {
    if (!isTalkingIdentity(participant.identity)) return;
    if (publication.kind !== TrackKind.KIND_AUDIO) return;
    link(participant.identity);
  });

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    if (!isPhoneIdentity(participant.identity)) return;
    cancelGrace();
    requestPhoneAudio(participant);
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (isRobotIdentity(participant.identity)) {
      cancelGrace();
      return;
    }
    if (isPhoneIdentity(participant.identity) && phonesInRoom(room).length === 0) {
      console.log(
        `[voice:live] iPhone ${participant.identity} left — ${PHONE_LEAVE_GRACE_MS}ms grace`,
      );
      cancelGrace();
      grace = setTimeout(() => {
        grace = null;
        if (phonesInRoom(room).length) return;
        console.log("[voice:live] phone did not return — ending GPT-Live job");
        onPhoneGone();
      }, PHONE_LEAVE_GRACE_MS);
      return;
    }
    if (participant.identity !== current) return;
    const next = pickTalkingPhone(room);
    if (next && phoneHasSubscribedMic(next)) {
      link(next.identity);
      return;
    }
    if (phonesInRoom(room).length) {
      cancelGrace();
      return;
    }
    console.log(`[voice:live] iPhone ${current} left — ${PHONE_LEAVE_GRACE_MS}ms grace`);
    cancelGrace();
    grace = setTimeout(() => {
      grace = null;
      const returned = pickTalkingPhone(room);
      if (returned) {
        if (phoneHasSubscribedMic(returned)) link(returned.identity);
        return;
      }
      if (phonesInRoom(room).length) return;
      console.log("[voice:live] phone did not return — ending GPT-Live job");
      onPhoneGone();
    }, PHONE_LEAVE_GRACE_MS);
  });
}

function clipAppend(text: string): string {
  if (text.length <= MAX_APPEND_CHARS) return text;
  return `${text.slice(0, MAX_APPEND_CHARS - 24)}\n…[truncated]`;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const missing = [
      "OPENAI_API_KEY",
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
    ].filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(`Missing env: ${missing.join(", ")}`);
    }

    const brain = await createAlfredBrain();
    const ui = createRoomUiTranscriptPublisher(() => ctx.room);
    const tools = createAlfredLiveTools(brain, {
      publishExpression: (event) => ui.publishExpression(event),
    });
    const voiceInstructions = buildLiveVoiceInstructions(brain);
    const backendInstructions = await buildLiveBackendInstructions(brain);

    console.log("[voice:live] job starting");
    console.log(`  Memory: ${brain.memoryProviderId} path=${brain.memoryPath}`);
    console.log(
      `  Persona: ${brain.persona.dir} (SOUL=${brain.persona.soul ? "yes" : "no"} IDENTITY=${brain.persona.identity ? "yes" : "no"} USER=${brain.persona.user ? "yes" : "no"})`,
    );
    console.log(`  GPT-Live voice=${LIVE_VOICE} backend=${BACKEND_MODEL}`);
    console.log(`  Room=${ctx.room.name} job=${ctx.job.id}`);

    const model = new openai.realtime.GPTLiveModel({
      voice: LIVE_VOICE,
      responsesOptions: {
        model: BACKEND_MODEL,
        instructions: backendInstructions,
        parallelToolCalls: true,
      },
    });

    const session = new voice.AgentSession({
      llm: model,
    });

    /** Accumulated assistant transcript for the current speaking turn (GPT-Live deltas). */
    let assistantAcc = "";

    const agent = voice.Agent.create({
      instructions: voiceInstructions,
      tools,
      async onEnter(agentCtx) {
        try {
          const duplex = agentCtx.agent.duplexSession as openai.realtime.GPTLiveSession;
          // Live assistant captions from GPT-Live output transcript deltas — never await.
          duplex.on("transcript_delta", (ev: { text?: string }) => {
            if (closed || !ev.text) return;
            if (!assistantAcc) ui.beginCaption("");
            assistantAcc += ev.text;
            ui.revealCaption(assistantAcc);
          });
        } catch (err) {
          console.warn("[voice:live] duplex transcript hook failed:", err);
        }
      },
      async transcriptionNode(_agentCtx, text) {
        // Also tee framework transcription streams when present (pass-through + HUD).
        return ui.teeTranscription(text);
      },
    });

    let closed = false;
    const closeEverything = async (reason: string) => {
      if (closed) return;
      closed = true;
      console.log(`[voice:live] closing session (${reason})`);
      try {
        session.shutdown({ drain: false });
      } catch (err) {
        console.warn("[voice:live] session.shutdown failed:", err);
      }
      try {
        await session.close();
      } catch (err) {
        console.warn("[voice:live] session.close failed:", err);
      }
      try {
        await model.close();
      } catch (err) {
        console.warn("[voice:live] model.close failed:", err);
      }
    };

    ctx.addShutdownCallback(async () => {
      await closeEverything("job_shutdown");
    });

    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      console.log(`[voice:live] AgentSession close reason=${ev.reason}`);
      if (!closed) ctx.shutdown(`session_close:${String(ev.reason)}`);
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const errText = String((ev as { error?: unknown }).error ?? ev);
      console.error("[voice:live] AgentSession error:", ev.error);
      if (/credit|quota|billing|balance.?exhausted|insufficient/i.test(errText)) {
        console.error(
          "[voice:live] OpenAI billing/credits exhausted — GPT-Live cannot fail over to Grok. " +
            "Run cascade instead: `make alfred` (Deepgram → Grok → ElevenLabs) with GROK_API_KEY set.",
        );
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (closed) return;
      if (ev.oldState === "speaking" && ev.newState !== "speaking") {
        ui.endCaption(ev.newState === "listening" ? "complete" : "interrupted");
        assistantAcc = "";
        ui.resetAssistant();
      }
    });

    const duplexSession = (): openai.realtime.GPTLiveSession | undefined => {
      try {
        return agent.duplexSession as openai.realtime.GPTLiveSession;
      } catch {
        return undefined;
      }
    };

    let enrichGen = 0;
    const commitAndEnrichUserTurn = (text: string): void => {
      const gen = ++enrichGen;

      void brain.memory
        .commitTurn({
          profileId: brain.profileId,
          sessionId: brain.sessionId,
          turnId: `turn_${Date.now().toString(36)}`,
          role: "user",
          text,
          metadata: { stack: "gpt-live", jobId: ctx.job.id },
        })
        .catch((err) => console.error("[voice:live] commitTurn (user) failed:", err));

      void (async () => {
        try {
          const [memory, decision] = await Promise.all([
            brain.memory.retrieve({
              text,
              profileId: brain.profileId,
              sessionId: brain.sessionId,
              limit: 8,
            }),
            brain.briefing.handleUserTurn(text),
          ]);
          if (closed || gen !== enrichGen) return;

          const duplex = duplexSession();
          if (!duplex) return;

          if (memory.items.length) {
            const block = memory.items.map((m, i) => `[${i + 1}] ${m.content}`).join("\n");
            duplex.appendThinking(
              clipAppend(`Retrieved long-term memory for this turn:\n${block}`),
            );
          }

          if (decision.action === "chat" && decision.appendOffer) {
            duplex.appendThinking(
              clipAppend(
                `${decision.systemHint ?? ""}\nAfter your short reply, ask: ${brain.briefing.offerCloser}`,
              ),
            );
          } else if (decision.action === "play") {
            if (decision.newsHeadlines?.length) {
              brain.news.rememberHeadlines(decision.newsHeadlines);
            }
            // Briefing speech also drives the caption HUD in parallel.
            ui.beginCaption("");
            ui.revealCaption(decision.speech);
            duplex.appendCommentary(clipAppend(decision.speech));
          } else if (decision.action === "decline") {
            ui.beginCaption("");
            ui.revealCaption(decision.speech);
            duplex.appendCommentary(clipAppend(decision.speech));
          }
        } catch (err) {
          console.warn("[voice:live] turn enrichment failed:", err);
        }
      })();
    };

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (closed || !ev.transcript.trim()) return;
      const text = ev.transcript.trim();

      // HUD first — never block speech / enrichment on data-channel publish.
      ui.publishUser(text, ev.isFinal ? "final" : "partial");

      if (!ev.isFinal) return;
      commitAndEnrichUserTurn(text);
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (closed) return;
      const item = ev.item;
      if (!item || typeof item !== "object") return;
      const msg = item as {
        role?: string;
        textContent?: string;
        content?: unknown;
      };
      if (msg.role !== "assistant") return;
      const text = (msg.textContent ?? String(msg.content ?? "")).trim();
      if (!text) return;

      // Fallback caption if GPT-Live deltas were sparse.
      if (!assistantAcc || text.length > assistantAcc.length) {
        if (!assistantAcc) ui.beginCaption("");
        assistantAcc = text;
        ui.revealCaption(text);
      }

      void brain.memory
        .commitTurn({
          profileId: brain.profileId,
          sessionId: brain.sessionId,
          turnId: `turn_${Date.now().toString(36)}`,
          role: "assistant",
          text,
          metadata: { stack: "gpt-live", jobId: ctx.job.id },
        })
        .catch((err) => console.error("[voice:live] commitTurn (assistant) failed:", err));
    });

    await ctx.connect();

    /** Typed chat arrives on `alfred.control` and LiveKit `lk.chat`. */
    let sessionReady = false;
    const pendingTyped: string[] = [];
    let lastTyped = { text: "", at: 0 };

    const submitTypedText = (text: string): void => {
      if (closed) return;
      const now = Date.now();
      if (text === lastTyped.text && now - lastTyped.at < 1_500) return;
      lastTyped = { text, at: now };
      if (!sessionReady) {
        pendingTyped.push(text);
        return;
      }
      ui.publishUser(text, "final");
      commitAndEnrichUserTurn(text);
      try {
        session.interrupt();
      } catch (err) {
        console.warn("[voice:live] interrupt before typed reply failed:", err);
      }
      try {
        session.generateReply({ userInput: text, inputModality: "text" });
        console.log(`[voice:live] typed turn (${text.length} chars)`);
      } catch (err) {
        console.error("[voice:live] generateReply (text) failed:", err);
      }
    };

    ctx.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (closed) return;
        if (!topic || topic === "alfred.control") {
          console.log(
            `[voice:live] control packet topic=${topic ?? "(none)"} from=${participant?.identity ?? "?"} bytes=${payload.byteLength}`,
          );
        }
        handleLiveControlPayload(payload, topic, {
          onText: submitTypedText,
          onStop: () => {
            try {
              session.interrupt();
            } catch (err) {
              console.warn("[voice:live] interrupt (stop) failed:", err);
            }
          },
          onMute: (muted) => {
            const duplex = duplexSession();
            if (!duplex) return;
            try {
              if (muted) duplex.muteInput();
              else duplex.unmuteInput();
            } catch (err) {
              console.warn("[voice:live] muteInput failed:", err);
            }
          },
        });
      },
    );

    try {
      ctx.room.registerTextStreamHandler("lk.chat", (reader, info) => {
        void reader
          .readAll()
          .then((raw) => {
            const text = raw.trim();
            if (!text) return;
            console.log(`[voice:live] lk.chat from ${info.identity} (${text.length} chars)`);
            submitTypedText(text);
          })
          .catch((err) => console.warn("[voice:live] lk.chat read failed:", err));
      });
    } catch (err) {
      console.warn("[voice:live] lk.chat handler not registered:", err);
    }

    const robotRoom = isRobotLiveRoom(ctx.room.name);
    const phoneIdentity = await waitForTalkingPhone(ctx.room);
    if (!phoneIdentity) {
      console.warn(
        "[voice:live] no Talk mic in the room (phone / desktop / AlfredBot) — leaving so we do not bind a silent peer",
      );
      ctx.shutdown("no_phone_audio");
      return;
    }

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        participantIdentity: phoneIdentity,
        // Unique Talk rooms end when the caller leaves. Robot rooms stay up
        // through a rematch flicker; hangup deletes the room.
        closeOnDisconnect: !robotRoom,
        // We register `lk.chat` ourselves so typed turns share submitTypedText.
        textEnabled: false,
      },
      outputOptions: {
        // Prefer immediate caption deltas for Alfred HUD; audio stays on GPT-Live.
        syncTranscription: false,
      },
    });

    sessionReady = true;
    for (const queued of pendingTyped.splice(0)) submitTypedText(queued);

    if (robotRoom) {
      watchRobotPhone(ctx.room, session, phoneIdentity, () => {
        ctx.shutdown("phone_left");
      });
    }

    console.log(
      `[voice:live] online agentName=${LIVE_AGENT_NAME} identity=${ctx.room.localParticipant?.identity ?? LIVE_IDENTITY} room=${ctx.room.name} phone=${phoneIdentity}`,
    );
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: LIVE_AGENT_NAME,
    requestFunc: async (req: JobRequest) => {
      console.log(
        `[voice:live] job request id=${req.id} room=${req.room?.name ?? "?"} agent=${req.agentName}`,
      );
      await req.accept("ALFRED", LIVE_IDENTITY, "gpt-live");
    },
  }),
);
