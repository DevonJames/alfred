/**
 * ElevenLabs Speech Engine (VOICE=live2).
 *
 * ElevenLabs owns mic, STT, turn-taking, and TTS (Alfred's cloned voice).
 * This process only answers transcripts with the desktop text brain.
 * GPT-Live (`VOICE=live`) is a separate LiveKit path and is not used here.
 */

import { createBriefingController, lookupLiveCryptoPrice, lookupLiveMetalsPrice, lookupLiveNewsHeadlines, lookupLiveWeatherForecast, speakSituationalRequest, summarizeNewsArticle, type BriefingController, type GreetingLlm, type NewsHeadline } from "@alfred/briefing";
import {
  extractBargeInText,
  hasInterruptCue,
  isEchoTranscript,
  looksLikeDocsIngestTask,
  looksLikeXIngestTask,
  normalizeForEcho,
  parseMarketsIntent,
  parseNewsIntent,
  parseSituationalIntent,
  parseStudioLightIntent,
  parseWeatherIntent,
  resolveNewsArticleIndex,
} from "@alfred/core";
import { createElgatoLightsController, type ElgatoLightsController } from "@alfred/elgato";
import { OpenAiResponsesLLMProvider } from "@alfred/provider-openai";
import { resolveGrokApiKey, XaiGrokLLMProvider } from "@alfred/provider-xai";
import { ElevenLabsClient, type SpeechEngineAttachment } from "@elevenlabs/elevenlabs-js";
import type { Server } from "node:http";
import { oipForProfile } from "./oip-memory.js";
import { cancelTextSession, delegateTextSessionTask, getTextSession, resetTextSession } from "./text-session.js";

const WS_PATH = "/ws";

let attachment: SpeechEngineAttachment | undefined;
let ready = false;

export function isSpeechEngineStack(): boolean {
  return (process.env.ALFRED_VOICE_STACK ?? "").trim().toLowerCase() === "live2";
}

export function speechEngineReady(): boolean {
  return ready;
}

export function speechEngineId(): string | undefined {
  const id = process.env.ELEVENLABS_SPEECH_ENGINE_ID?.trim();
  return id || undefined;
}

function sessionKey(conversationId: string | undefined): string {
  return conversationId ? `live2:${conversationId}` : "live2";
}

function latestUserText(transcript: Array<{ role: string; content: string }>): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message?.role === "user" && message.content.trim()) return message.content.trim();
  }
  return "";
}

interface TurnMemory {
  lastUser: string;
  /** Reply currently streaming. */
  lastAssistant: string;
  /** Last reply that was actually spoken. Echo arrives after this is complete. */
  recentSpoken: string;
  /** Mic text before this time is playback leaking back in, unless the user cuts in. */
  echoGuardUntil: number;
}

const turnMemory = new Map<string, TurnMemory>();
const activeReplyKeys = new Set<string>();
let repliesHushed = false;
/** Bumped when a new user turn is accepted, so a cut reply cannot re-arm the echo guard. */
let replyEpoch = 0;

/** Shhh. Stop the reply already being generated and take the next words as a new question. */
export async function hushSpeechEngineReplies(): Promise<void> {
  repliesHushed = true;
  replyEpoch += 1;
  for (const memory of turnMemory.values()) memory.echoGuardUntil = 0;
  await Promise.all([...activeReplyKeys].map((sessionKey) => cancelTextSession({ sessionKey })));
}

/** Same cooldown the cascade voice session uses after Alfred stops speaking. */
const ECHO_COOLDOWN_MS = Number(process.env.ALFRED_ECHO_COOLDOWN_MS ?? 2500);

/**
 * Cascade drops self-hearing with browser AEC, a PCM self-voice gate, then
 * this transcript filter. Speech Engine owns the audio, so the PCM gate cannot
 * run here. The mic is closed while he speaks. A follow-up that contains a
 * word he did not just say is a new turn; a replay of his line is not.
 */
export function acceptLiveTranscript(
  text: string,
  assistant: string,
  lastUser: string,
  speaking: boolean,
): string | null {
  const heard = text.trim();
  if (!heard || heard === lastUser) return null;
  const input = {
    heard,
    assistantSpeech: assistant,
    userTurn: lastUser,
    aggressiveShort: speaking,
  };
  // Peel a real follow-up off a glued echo before deciding. The raw string
  // often overlaps the reply enough to look like pure echo.
  const cleaned = extractBargeInText(input).trim();
  if (!cleaned || cleaned === lastUser) return null;
  if (isEchoTranscript({ ...input, heard: cleaned })) return null;
  if (
    speaking &&
    !hasInterruptCue(heard) &&
    !hasInterruptCue(cleaned) &&
    !hasNovelWord(cleaned, assistant)
  ) {
    return null;
  }
  return cleaned;
}

/** A content word the assistant did not just say. "Briefing" passes; "volcano" during that story does not. */
function hasNovelWord(heard: string, assistant: string): boolean {
  const spoken = new Set(normalizeForEcho(assistant).split(" ").filter((word) => word.length >= 6));
  return normalizeForEcho(heard)
    .split(" ")
    .some((word) => word.length >= 6 && !spoken.has(word));
}

let briefing: BriefingController | undefined;

/** Same short briefing salutation cascade asks the conversational model for. */
const greetingLlm: GreetingLlm = async (messages) => {
  const providers = [];
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) providers.push(new OpenAiResponsesLLMProvider({ apiKey: openaiKey }));
  const grokKey = resolveGrokApiKey();
  if (grokKey) providers.push(new XaiGrokLLMProvider({ apiKey: grokKey }));
  for (const llm of providers) {
    try {
      let text = "";
      let failed = false;
      for await (const chunk of llm.generateStream({
        messages,
        modelPreset: "conversational",
        reasoningEffort: "none",
      })) {
        if (chunk.type === "error") {
          failed = true;
          break;
        }
        if (chunk.type === "token" && chunk.text) text += chunk.text;
      }
      if (!failed && text.trim()) return text.trim();
    } catch {
      /* try the next model */
    }
  }
  return "";
};

function briefingController(): BriefingController {
  briefing ??= createBriefingController({ memory: oipForProfile(), llm: greetingLlm });
  return briefing;
}

let lights: ElgatoLightsController | undefined;
/** Last spoken news rundown for this Speech Engine process. */
let recentNews: NewsHeadline[] = [];

function lightsController(): ElgatoLightsController {
  if (!lights) {
    lights = createElgatoLightsController();
    void lights.refresh().catch((err) => {
      console.warn("[speech-engine] Elgato light discovery failed:", err);
    });
  }
  return lights;
}

let lightsHintCache: { atMs: number; text?: string } | undefined;

/** Same inventory line cascade puts in the prompt so unnamed lights mean every light. */
async function lightsInventoryHint(): Promise<string | undefined> {
  const now = Date.now();
  if (lightsHintCache && now - lightsHintCache.atMs < 60_000) return lightsHintCache.text;
  try {
    const hint = (await lightsController().inventorySpeech()).trim();
    const text = hint || undefined;
    lightsHintCache = { atMs: now, text };
    return text;
  } catch (err) {
    console.warn("[speech-engine] studio lights inventory failed:", err);
    lightsHintCache = { atMs: now, text: undefined };
    return undefined;
  }
}

/**
 * Cascade answers lights, situational lookups, weather, news, docs ingest, and X ingest before the LLM.
 */
async function toolSpeech(key: string, text: string): Promise<string | null> {
  const lightsCommand = parseStudioLightIntent(text);
  if (lightsCommand) {
    try {
      const spoken = await lightsController().control(lightsCommand);
      console.log(`[speech-engine] lights ${lightsCommand.action}: ${spoken.slice(0, 160)}`);
      return spoken;
    } catch (err) {
      console.error("[speech-engine] lights failed:", err);
      return "I couldn't reach the lights just now.";
    }
  }
  const situational = parseSituationalIntent(text);
  if (situational) {
    try {
      const spoken = await speakSituationalRequest(situational);
      console.log(`[speech-engine] ${situational.tool}: ${spoken.slice(0, 160)}`);
      return spoken;
    } catch (err) {
      console.error(`[speech-engine] ${situational.tool} failed:`, err);
      return "I couldn't look that up just now.";
    }
  }
  const weatherIntent = parseWeatherIntent(text);
  if (weatherIntent) {
    try {
      const spoken = await lookupLiveWeatherForecast({
        location: weatherIntent.location,
        days: weatherIntent.days,
      });
      console.log(`[speech-engine] weather: ${spoken.slice(0, 160)}`);
      return spoken;
    } catch (err) {
      console.error("[speech-engine] weather failed:", err);
      return "I couldn't get the weather just now.";
    }
  }
  const newsIntent = parseNewsIntent(text);
  if (newsIntent) {
    try {
      if (newsIntent.kind === "headlines") {
        const result = await lookupLiveNewsHeadlines();
        recentNews = result.headlines;
        console.log(`[speech-engine] news headlines (${result.headlines.length})`);
        return result.speech;
      }
      const resolved = resolveNewsArticleIndex(newsIntent, recentNews.length);
      const spoken = await summarizeNewsArticle({
        ...resolved,
        recent: recentNews,
        llm: greetingLlm,
      });
      console.log(`[speech-engine] news article: ${spoken.slice(0, 160)}`);
      return spoken;
    } catch (err) {
      console.error("[speech-engine] news failed:", err);
      return "I couldn't get the news just now.";
    }
  }
  const marketsIntent = parseMarketsIntent(text);
  if (marketsIntent) {
    try {
      const spoken =
        marketsIntent.kind === "crypto"
          ? await lookupLiveCryptoPrice({ cryptoId: marketsIntent.cryptoId })
          : await lookupLiveMetalsPrice({ metalSymbol: marketsIntent.metalSymbol });
      console.log(`[speech-engine] markets ${marketsIntent.kind}: ${spoken.slice(0, 160)}`);
      return spoken;
    } catch (err) {
      console.error("[speech-engine] markets failed:", err);
      return "I couldn't get that price just now.";
    }
  }
  if (looksLikeDocsIngestTask(text)) {
    void delegateTextSessionTask(
      { sessionKey: key },
      { category: "research", description: text },
    ).catch((err) => console.error("[speech-engine] docs ingest failed:", err));
    console.log("[speech-engine] docs ingest");
    return "I'll ingest your documentation folder into memory now.";
  }
  if (looksLikeXIngestTask(text)) {
    const isUrl = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(text);
    if (!isUrl) {
      void delegateTextSessionTask(
        { sessionKey: key },
        { category: "research", description: text },
      ).catch((err) => console.error("[speech-engine] X ingest failed:", err));
      console.log("[speech-engine] X ingest");
      return "I'll ingest your X notes into memory now. New items will show up in today's briefing.";
    }
    try {
      const result = await delegateTextSessionTask(
        { sessionKey: key },
        { category: "research", description: text },
      );
      const spoken =
        result.status === "failed"
          ? result.error || result.output || "I couldn't ingest that X link."
          : result.output || "Saved that X link to memory.";
      console.log(`[speech-engine] X link: ${spoken.slice(0, 160)}`);
      return spoken;
    } catch (err) {
      console.error("[speech-engine] X ingest failed:", err);
      return "I couldn't ingest that X link.";
    }
  }
  return null;
}

type BriefingTurn = {
  speak?: string;
  offerHint?: string;
  offerCloser?: string;
};

/** Cascade and GPT-Live answer "daily briefing" through the briefing controller. This path does too. */
async function briefingTurn(text: string): Promise<BriefingTurn> {
  try {
    const decision = await briefingController().handleUserTurn(text);
    if (decision.action === "play" || decision.action === "decline") return { speak: decision.speech };
    if (decision.action === "chat" && decision.appendOffer) {
      return { offerHint: decision.systemHint, offerCloser: briefingController().offerCloser };
    }
    return {};
  } catch (err) {
    console.error("[speech-engine] briefing failed:", err);
    if (/\bbrief/i.test(text)) return { speak: "I couldn't put the briefing together just now." };
    return {};
  }
}

/** How long the spoken reply can still be coming out of the speakers. */
function playbackTailMs(text: string): number {
  const spokenMs = Math.ceil((text.trim().length / 12) * 1000);
  return Math.min(spokenMs + ECHO_COOLDOWN_MS, 90_000);
}

/** Yield text-brain tokens as they arrive so Speech Engine can start TTS early. */
function streamReply(key: string, text: string, signal: AbortSignal): AsyncIterable<string> {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown;

  const nudge = () => {
    wake?.();
    wake = null;
  };

  activeReplyKeys.add(key);
  const work = (async () => {
    if (repliesHushed || signal.aborted) return;
    const brief = await briefingTurn(text);
    if (signal.aborted) return;
    if (brief.speak) {
      console.log(`[speech-engine] briefing: ${brief.speak.slice(0, 160)}`);
      queue.push(brief.speak);
      nudge();
      return;
    }
    const direct = await toolSpeech(key, text);
    if (signal.aborted) return;
    if (direct) {
      queue.push(direct);
      nudge();
      return;
    }
    const lightsHint = await lightsInventoryHint();
    const extraSystem = [brief.offerHint, lightsHint].filter(Boolean).join("\n\n");
    const session = await getTextSession({ sessionKey: key });
    if (signal.aborted) return;
    let streamed = "";
    await session.handleUserUtterance({
      text,
      extraSystem: extraSystem || undefined,
      onToken: (delta) => {
        if (repliesHushed || signal.aborted || !delta) return;
        streamed += delta;
        queue.push(delta);
        nudge();
      },
    });
    if (brief.offerCloser && !streamed.includes(brief.offerCloser)) {
      queue.push(` ${brief.offerCloser}`);
      nudge();
    }
  })()
    .catch((err) => {
      failure = err;
    })
    .finally(() => {
      activeReplyKeys.delete(key);
      finished = true;
      nudge();
    });

  const onAbort = () => {
    void cancelTextSession({ sessionKey: key });
    finished = true;
    nudge();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          if (repliesHushed) break;
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (finished) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        await work;
        if (failure && !signal.aborted) throw failure;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export async function attachSpeechEngine(httpServer: Server): Promise<void> {
  if (!isSpeechEngineStack()) return;
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || process.env.ELEVEN_API_KEY?.trim();
  const engineId = speechEngineId();
  if (!apiKey || !engineId) {
    console.warn(
      "[speech-engine] VOICE=live2 needs ELEVENLABS_API_KEY and ELEVENLABS_SPEECH_ENGINE_ID. " +
        "Create one with `pnpm speech-engine:create` (uses wss://api.alfrd.net/speech/<desktopClientId>/ws).",
    );
    return;
  }

  const elevenlabs = new ElevenLabsClient({ apiKey });
  await elevenlabs.speechEngine.update(engineId, {
    // Eager + speculative turns commit speaker bleed as a user turn, which
    // aborts the reply already being spoken.
    turn: {
      turnEagerness: "patient",
      speculativeTurn: false,
    },
    conversation: {
      clientEvents: [
        "audio",
        "interruption",
        "user_transcript",
        "tentative_user_transcript",
        "agent_response",
        "agent_response_correction",
        "ping",
      ],
    },
  });
  const engine = await elevenlabs.speechEngine.get(engineId);
  attachment = engine.attach(httpServer, WS_PATH, {
    debug: process.env.ALFRED_SPEECH_ENGINE_DEBUG === "1",
    onInit(conversationId) {
      console.log(`[speech-engine] session ${conversationId}`);
    },
    async onTranscript(transcript, signal, session) {
      const key = sessionKey(session.conversationId);
      const memory = turnMemory.get(key) ?? {
        lastUser: "",
        lastAssistant: "",
        recentSpoken: "",
        echoGuardUntil: 0,
      };
      const spoken = [memory.recentSpoken, memory.lastAssistant].filter(Boolean).join("\n");
      const speaking = Date.now() < memory.echoGuardUntil;
      const raw = latestUserText(transcript);
      const text = acceptLiveTranscript(raw, spoken, memory.lastUser, speaking);
      if (!text || signal.aborted) {
        if (raw.trim() && raw.trim() !== memory.lastUser) {
          console.log(`[speech-engine] echo ignored: ${raw.trim().slice(0, 160)}`);
        }
        // Every transcript must get a response. Skipping drops the ElevenLabs session,
        // which leaves the browser mic captions alive and Alfred unable to answer.
        if (!signal.aborted) {
          try {
            await session.sendResponse("");
          } catch (err) {
            console.warn(
              "[speech-engine] echo ack failed:",
              err instanceof Error ? err.message : err,
            );
          }
        }
        return;
      }
      repliesHushed = false;
      memory.lastUser = text;
      memory.lastAssistant = "";
      memory.echoGuardUntil = Date.now() + 120_000;
      turnMemory.set(key, memory);
      const epoch = replyEpoch;
      console.log(`[speech-engine] user: ${text.slice(0, 160)}`);
      try {
        let reply = "";
        await session.sendResponse(
          (async function* () {
            for await (const chunk of streamReply(key, text, signal)) {
              reply += chunk;
              memory.lastAssistant = reply;
              yield chunk;
            }
          })(),
        );
        if (epoch !== replyEpoch) return;
        if (reply.trim()) memory.recentSpoken = reply.trim();
        memory.echoGuardUntil = repliesHushed ? 0 : Date.now() + playbackTailMs(reply);
      } catch (err) {
        if (epoch === replyEpoch && !repliesHushed) {
          memory.echoGuardUntil = Date.now() + ECHO_COOLDOWN_MS;
        }
        if (signal.aborted) {
          // A newer transcript owns the turn; that handler must respond.
          return;
        }
        console.error("[speech-engine] reply failed:", err);
        try {
          await session.sendResponse("Sorry — I hit a snag on that one.");
        } catch (sendErr) {
          console.warn(
            "[speech-engine] error reply failed:",
            sendErr instanceof Error ? sendErr.message : sendErr,
          );
        }
      }
    },
    onClose(session) {
      console.log(`[speech-engine] closed ${session.conversationId ?? ""}`);
      const key = sessionKey(session.conversationId);
      turnMemory.delete(key);
      void resetTextSession({ sessionKey: key });
    },
    onDisconnect(session) {
      console.warn(`[speech-engine] dropped ${session.conversationId ?? ""}`);
      const key = sessionKey(session.conversationId);
      turnMemory.delete(key);
      void resetTextSession({ sessionKey: key });
    },
    onError(error) {
      console.error("[speech-engine]", error.message);
    },
  });
  ready = true;
  console.log(`[speech-engine] attached ${engineId} on ${WS_PATH}`);
  console.log("  Public URL is the relay path logged as [CloudConnect] Speech Engine URL.");
}

export async function mintSpeechEngineConversationToken(): Promise<
  | {
      ok: true;
      body: {
        voiceStack: "live2";
        conversationToken: string;
        /** Live captions while the user is still talking. The conversation token only arrives at end of turn. */
        scribeToken?: string;
        provider: "elevenlabs-speech-engine";
      };
    }
  | { ok: false; error: string; status: 500 | 503 }
> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || process.env.ELEVEN_API_KEY?.trim();
  const engineId = speechEngineId();
  if (!apiKey || !engineId) {
    return {
      ok: false,
      status: 503,
      error:
        "Speech Engine is not configured. Set ELEVENLABS_API_KEY and ELEVENLABS_SPEECH_ENGINE_ID, then restart `make alfred VOICE=live2`.",
    };
  }
  if (!ready) {
    return {
      ok: false,
      status: 503,
      error: "Speech Engine WebSocket is not attached yet. Check desktop logs for [speech-engine].",
    };
  }
  try {
    const elevenlabs = new ElevenLabsClient({ apiKey });
    const response = await elevenlabs.conversationalAi.conversations.getWebrtcToken({
      agentId: engineId,
    });
    let scribeToken: string | undefined;
    try {
      const scribe = await elevenlabs.tokens.singleUse.create("realtime_scribe");
      scribeToken = scribe.token;
    } catch (err) {
      console.warn(
        "[speech-engine] live transcript token failed:",
        err instanceof Error ? err.message : err,
      );
    }
    return {
      ok: true,
      body: {
        voiceStack: "live2",
        conversationToken: response.token,
        scribeToken,
        provider: "elevenlabs-speech-engine",
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function closeSpeechEngine(): Promise<void> {
  ready = false;
  await attachment?.close();
  attachment = undefined;
}
