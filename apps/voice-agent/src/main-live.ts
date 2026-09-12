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
import * as openai from "@livekit/agents-plugin-openai";
import { createAlfredBrain } from "./brain.js";
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

function clipAppend(text: string): string {
  if (text.length <= MAX_APPEND_CHARS) return text;
  return `${text.slice(0, MAX_APPEND_CHARS - 24)}\n…[truncated]`;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const missing = ["OPENAI_API_KEY", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].filter(
      (k) => !process.env[k],
    );
    if (missing.length) {
      throw new Error(`Missing env: ${missing.join(", ")}`);
    }

    const brain = await createAlfredBrain();
    const tools = createAlfredLiveTools(brain);
    const voiceInstructions = buildLiveVoiceInstructions(brain);
    const backendInstructions = await buildLiveBackendInstructions(brain);
    const ui = createRoomUiTranscriptPublisher(() => ctx.room);

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
      console.error("[voice:live] AgentSession error:", ev.error);
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      if (closed) return;
      if (ev.oldState === "speaking" && ev.newState !== "speaking") {
        ui.endCaption(ev.newState === "listening" ? "complete" : "interrupted");
        assistantAcc = "";
        ui.resetAssistant();
      }
    });

    let enrichGen = 0;
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (closed || !ev.transcript.trim()) return;
      const text = ev.transcript.trim();

      // HUD first — never block speech / enrichment on data-channel publish.
      ui.publishUser(text, ev.isFinal ? "final" : "partial");

      if (!ev.isFinal) return;

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

          const duplex = (() => {
            try {
              return agent.duplexSession as openai.realtime.GPTLiveSession;
            } catch {
              return undefined;
            }
          })();
          if (!duplex) return;

          if (memory.items.length) {
            const block = memory.items.map((m, i) => `[${i + 1}] ${m.content}`).join("\n");
            duplex.appendThinking(clipAppend(`Retrieved long-term memory for this turn:\n${block}`));
          }

          if (decision.action === "chat" && decision.appendOffer) {
            duplex.appendThinking(
              clipAppend(
                `${decision.systemHint ?? ""}\nAfter your short reply, ask: ${brain.briefing.offerCloser}`,
              ),
            );
          } else if (decision.action === "play") {
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

    await session.start({
      agent,
      room: ctx.room,
      outputOptions: {
        // Prefer immediate caption deltas for Alfred HUD; audio stays on GPT-Live.
        syncTranscription: false,
      },
    });

    console.log(
      `[voice:live] online agentName=${LIVE_AGENT_NAME} identity=${LIVE_IDENTITY} room=${ctx.room.name}`,
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
