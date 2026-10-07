/**
 * ElevenLabs Speech Engine (VOICE=live2).
 *
 * ElevenLabs owns mic, STT, turn-taking, and TTS (Alfred's cloned voice).
 * This process only answers transcripts with the desktop text brain.
 * GPT-Live (`VOICE=live`) is a separate LiveKit path and is not used here.
 */

import {
  createBriefingController,
  lookupCurrentTime,
  lookupLiveCryptoPrice,
  lookupLiveMetalsPrice,
  lookupLiveNewsHeadlines,
  lookupLiveWeatherForecast,
  speakSituationalRequest,
  summarizeNewsArticle,
  type BriefingController,
  type BriefingDisplay,
  type GreetingLlm,
  type NewsHeadline,
} from "@alfred/briefing";
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
  parseTimeIntent,
  parseWeatherIntent,
  resolveNewsFollowUp,
  createHttpArchivePort,
} from "@alfred/core";
import { createElgatoLightsController, type ElgatoLightsController } from "@alfred/elgato";
import { OpenAiResponsesLLMProvider } from "@alfred/provider-openai";
import { resolveGrokApiKey, XaiGrokLLMProvider } from "@alfred/provider-xai";
import { ElevenLabsClient, type SpeechEngineAttachment } from "@elevenlabs/elevenlabs-js";
import type { Server } from "node:http";
import { agendaBriefingEvents } from "./agenda-briefing.js";
import { answerAgendaTurn, answerLooseScheduleTurn, currentAgendaEar } from "./agenda-turn.js";
import { loadTaskReminders } from "./message-commitments.js";
import { noteConversationTurn } from "./conversation-thread.js";
import { appendLive2ConversationTurn } from "./conversation-history.js";
import { oipForProfile } from "./oip-memory.js";
import { cancelTextSession, delegateTextSessionTask, getTextSession, rememberSpokenNews, resetTextSession } from "./text-session.js";

const WS_PATH = "/ws";

let attachment: SpeechEngineAttachment | undefined;
let ready = false;
/** Next transcript is answered with this text, already composed by the agenda. */
let verbatimSpeech: { text: string; until: number } | null = null;

/** Speak this exact reply on the live Speech Engine session. The next user turn carries it. */
export function primeVerbatimSpeech(text: string, opts?: { maxChars?: number }): void {
  const trimmed = text.trim();
  if (!trimmed) {
    verbatimSpeech = null;
    return;
  }
  const maxChars = opts?.maxChars ?? 1500;
  verbatimSpeech = { text: trimmed.slice(0, maxChars), until: Date.now() + 30_000 };
}

function takeVerbatimSpeech(): string | null {
  const pending = verbatimSpeech;
  verbatimSpeech = null;
  if (!pending || Date.now() > pending.until) return null;
  return pending.text;
}

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

/** Structured Daily Brief layout for the voice HUD (not spoken text). */
let briefingHud: { display: BriefingDisplay; spokenAt: number; until: number } | null = null;

export function publishBriefingHud(display: BriefingDisplay): void {
  const now = Date.now();
  briefingHud = { display, spokenAt: now, until: now + 15 * 60_000 };
}

export function clearBriefingHud(): void {
  briefingHud = null;
}

export function getBriefingHud(): { display: BriefingDisplay; spokenAt: number } | null {
  if (!briefingHud || Date.now() > briefingHud.until) {
    briefingHud = null;
    return null;
  }
  return { display: briefingHud.display, spokenAt: briefingHud.spokenAt };
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
/**
 * Briefing (or other long) replies finished after the Speech Engine aborted the
 * turn — usually a second STT final of the same ask. The duplicate transcript
 * handler waits for this and speaks it instead of acking empty.
 */
const pendingAbortedReplies = new Map<
  string,
  { speak: string; display?: BriefingDisplay; userNorm: string; until: number }
>();
let repliesHushed = false;
/** Bumped when a new user turn is accepted, so a cut reply cannot re-arm the echo guard. */
let replyEpoch = 0;

function stashAbortedReply(
  key: string,
  userText: string,
  speak: string,
  display?: BriefingDisplay,
): void {
  pendingAbortedReplies.set(key, {
    speak,
    display,
    userNorm: normalizeForEcho(userText),
    until: Date.now() + 90_000,
  });
}

function takeAbortedReply(key: string, heard: string): { speak: string; display?: BriefingDisplay } | null {
  const pending = pendingAbortedReplies.get(key);
  if (!pending) return null;
  if (Date.now() > pending.until) {
    pendingAbortedReplies.delete(key);
    return null;
  }
  const heardNorm = normalizeForEcho(heard);
  if (heardNorm !== pending.userNorm && !heardNorm.includes(pending.userNorm) && !pending.userNorm.includes(heardNorm)) {
    return null;
  }
  pendingAbortedReplies.delete(key);
  return { speak: pending.speak, display: pending.display };
}

async function waitForAbortedReply(
  key: string,
  heard: string,
  opts?: { timeoutMs?: number },
): Promise<{ speak: string; display?: BriefingDisplay } | null> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = takeAbortedReply(key, heard);
    if (ready) return ready;
    if (!activeReplyKeys.has(key) || Date.now() >= deadline) {
      return takeAbortedReply(key, heard);
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

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
  if (!heard) return null;
  // Punctuation-only STT re-finals of the same ask ("Alfred." vs "Alfred,") must
  // not start a second turn — that aborts the in-flight briefing generate.
  if (lastUser && normalizeForEcho(heard) === normalizeForEcho(lastUser)) return null;
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
  briefing ??= createBriefingController({
    memory: oipForProfile(),
    llm: greetingLlm,
    taskReminders: loadTaskReminders,
    agendaEvents: agendaBriefingEvents,
  });
  return briefing;
}

/** Re-arm soft-offer for the live Speech Engine controller (disk + in-process flags). */
export async function resetSpeechEngineBriefingOffer(): Promise<void> {
  await briefingController().resetSoftOffer();
}

let lights: ElgatoLightsController | undefined;
/** Last spoken news rundown for this Speech Engine process. */
let recentNews: NewsHeadline[] = [];

/**
 * Summarize a headline from the last briefing/news rundown and prime it so the
 * next Speech Engine user turn speaks it (bypasses echo hold during briefing TTS).
 */
export async function digSpeechEngineNewsArticle(opts: {
  index?: number;
  match?: string;
  url?: string;
  title?: string;
}): Promise<{ speech: string }> {
  if (!recentNews.length && !opts.url?.trim()) {
    throw new Error("No recent headlines — play the briefing or ask for the news first.");
  }
  // Stop briefing TTS while we fetch/summarize so the click isn't drowned out,
  // and clear echo hold so the follow-up user message isn't dropped as bleed.
  await hushSpeechEngineReplies();
  try {
    const speech = await summarizeNewsArticle({
      index: opts.index,
      match: opts.match,
      url: opts.url,
      title: opts.title,
      recent: recentNews,
      llm: greetingLlm,
    });
    const trimmed = speech.trim();
    if (!trimmed) throw new Error("I couldn't dig into that headline just now.");
    for (const memory of turnMemory.values()) {
      memory.echoGuardUntil = 0;
    }
    primeVerbatimSpeech(trimmed, { maxChars: 4500 });
    console.log(`[speech-engine] news dig primed: ${trimmed.slice(0, 160)}`);
    return { speech: trimmed };
  } finally {
    repliesHushed = false;
  }
}

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
  const timeIntent = parseTimeIntent(text);
  if (timeIntent) {
    try {
      const spoken = await lookupCurrentTime(timeIntent);
      console.log(`[speech-engine] time: ${spoken.slice(0, 160)}`);
      return spoken;
    } catch (err) {
      console.error("[speech-engine] time failed:", err);
      return "I couldn't read the clock just now.";
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
  if (newsIntent?.kind === "headlines") {
    try {
      const result = await lookupLiveNewsHeadlines();
      recentNews = result.headlines;
      rememberSpokenNews(key, recentNews);
      console.log(`[speech-engine] news headlines (${result.headlines.length})`);
      return result.speech;
    } catch (err) {
      console.error("[speech-engine] news failed:", err);
      return "I couldn't get the news just now.";
    }
  }
  const follow = resolveNewsFollowUp(
    text,
    recentNews.map((headline) => headline.title),
  );
  if (newsIntent?.kind === "article" || follow) {
    try {
      if (!recentNews.length) {
        return "I don't have a recent headline list to dig into. Ask for the news, or play the daily briefing first.";
      }
      if (!follow || follow === "ask" || (follow.index == null && !follow.match)) {
        return "Which headline should I dig into — say the number, or a few words from the title.";
      }
      const spoken = await summarizeNewsArticle({
        ...follow,
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
  newsHeadlines?: NewsHeadline[];
  display?: BriefingDisplay;
  offerHint?: string;
  offerCloser?: string;
  /** Soft offer chosen but not marked yet — mark only once we actually speak it. */
  shouldMarkOffered?: boolean;
};

/**
 * Cascade soft-offers the briefing on the first eligible turn of the day.
 * Live2 does too: play/decline short-circuit, otherwise optionally append the ask
 * after whatever reply we speak (chat, weather, lights, etc.).
 */
async function briefingTurn(text: string): Promise<BriefingTurn> {
  try {
    const ctrl = briefingController();
    const intent = await ctrl.detectIntent(text);
    if (intent === "explicitAsk" || intent === "affirmOffer") {
      const payload = await ctrl.generate({
        refresh: true,
        markSurfaced: true,
        userText: text,
      });
      await ctrl.markPlayed();
      return {
        speak: payload.speech,
        newsHeadlines: payload.briefing.news,
        display: payload.display,
      };
    }
    if (intent === "declineOffer") {
      await ctrl.markDeclined();
      return { speak: ctrl.declineAck };
    }
    if (await ctrl.shouldSoftOffer()) {
      return {
        offerHint: ctrl.offerSystemHint,
        offerCloser: ctrl.offerCloser,
        shouldMarkOffered: true,
      };
    }
    ctrl.noteUserTurnSeen();
    return {};
  } catch (err) {
    console.error("[speech-engine] briefing failed:", err);
    if (/\bbrief/i.test(text)) return { speak: "I couldn't put the briefing together just now." };
    return {};
  }
}

function withBriefingOffer(speech: string, offerCloser?: string): string {
  if (!offerCloser) return speech;
  if (speech.includes(offerCloser)) return speech;
  return `${speech.trim()} ${offerCloser}`;
}

async function commitBriefingOffer(brief: BriefingTurn): Promise<void> {
  if (!brief.shouldMarkOffered || !brief.offerCloser) return;
  try {
    await briefingController().markOffered();
    console.log(`[speech-engine] briefing offer: ${brief.offerCloser}`);
  } catch (err) {
    console.warn("[speech-engine] briefing offer mark failed:", err);
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
    if (brief.speak) {
      if (brief.newsHeadlines?.length) {
        recentNews = brief.newsHeadlines;
        rememberSpokenNews(key, recentNews);
      }
      if (brief.display) publishBriefingHud(brief.display);
      else clearBriefingHud();
      console.log(`[speech-engine] briefing: ${brief.speak.slice(0, 160)}`);
      // A duplicate STT final often aborts this turn while generate() is still
      // running. Stash so the echo handler can speak the briefing instead of "".
      if (signal.aborted) {
        stashAbortedReply(key, text, brief.speak, brief.display);
        return;
      }
      queue.push(brief.speak);
      nudge();
      return;
    }
    if (signal.aborted) return;
    clearBriefingHud();
    const direct = await toolSpeech(key, text);
    if (signal.aborted) return;
    if (direct) {
      const spoken = withBriefingOffer(direct, brief.offerCloser);
      await commitBriefingOffer(brief);
      if (signal.aborted) {
        stashAbortedReply(key, text, spoken);
        return;
      }
      queue.push(spoken);
      nudge();
      return;
    }
    const archiveUrl = process.env.ALFRED_ARCHIVE_URL?.trim();
    if (archiveUrl) {
      try {
        const spoken = await createHttpArchivePort(archiveUrl).ask(text);
        if (spoken) {
          console.log(`[speech-engine] archive: ${spoken.slice(0, 160)}`);
          queue.push(withBriefingOffer(spoken, brief.offerCloser));
          await commitBriefingOffer(brief);
          nudge();
          return;
        }
      } catch (err) {
        console.error("[speech-engine] archive ask failed:", err);
      }
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
    await commitBriefingOffer(brief);
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

const TYPED_CHAT_KEY = "typed-chat";

/**
 * Compose a reply for a typed Talk message without sending it through Speech Engine TTS.
 * Used by the chat composer so typed turns stay silent.
 */
export async function generateSilentTextReply(
  text: string,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const signal = opts?.signal ?? AbortSignal.timeout(180_000);
  noteConversationTurn("user", trimmed);
  void appendLive2ConversationTurn({ role: "user", text: trimmed, source: "text" }).catch((err) =>
    console.warn("[speech-engine] conversation history (typed user) failed:", err),
  );
  let reply = "";
  for await (const chunk of streamReply(TYPED_CHAT_KEY, trimmed, signal)) {
    reply += chunk;
  }
  const out = reply.trim();
  if (out) {
    noteConversationTurn("assistant", out);
    void appendLive2ConversationTurn({
      role: "assistant",
      text: out,
      source: "text",
    }).catch((err) =>
      console.warn("[speech-engine] conversation history (typed assistant) failed:", err),
    );
  }
  return out;
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
      const verbatim = takeVerbatimSpeech();
      if (verbatim && !signal.aborted) {
        repliesHushed = false;
        memory.lastAssistant = verbatim;
        memory.recentSpoken = verbatim;
        memory.echoGuardUntil = Date.now() + playbackTailMs(verbatim);
        turnMemory.set(key, memory);
        console.log(`[speech-engine] agenda: ${verbatim.slice(0, 160)}`);
        try {
          await session.sendResponse(verbatim);
        } catch (err) {
          console.error("[speech-engine] agenda speak failed:", err);
        }
        return;
      }
      const text = acceptLiveTranscript(raw, spoken, memory.lastUser, speaking);
      if (!text || signal.aborted) {
        const sameAsk =
          Boolean(raw.trim()) &&
          Boolean(memory.lastUser) &&
          normalizeForEcho(raw) === normalizeForEcho(memory.lastUser);
        if (raw.trim() && raw.trim() !== memory.lastUser) {
          console.log(`[speech-engine] echo ignored: ${raw.trim().slice(0, 160)}`);
        }
        // Duplicate STT final of the ask we are still answering — wait for the
        // aborted worker to stash the briefing/tool reply, then speak it here.
        if (!signal.aborted && sameAsk && (activeReplyKeys.has(key) || pendingAbortedReplies.has(key))) {
          console.log("[speech-engine] delivering reply after duplicate transcript");
          try {
            const recovered = await waitForAbortedReply(key, raw);
            if (recovered?.speak) {
              if (recovered.display) publishBriefingHud(recovered.display);
              memory.lastAssistant = recovered.speak;
              memory.recentSpoken = recovered.speak;
              memory.echoGuardUntil = Date.now() + playbackTailMs(recovered.speak);
              turnMemory.set(key, memory);
              await session.sendResponse(recovered.speak);
              noteConversationTurn("assistant", recovered.speak);
              void appendLive2ConversationTurn({
                role: "assistant",
                text: recovered.speak,
                source: "voice",
              }).catch((err) =>
                console.warn("[speech-engine] conversation history (assistant) failed:", err),
              );
              return;
            }
          } catch (err) {
            console.error("[speech-engine] recovered reply failed:", err);
          }
        }
        // Speaker-bleed while Alfred is still talking (e.g. "Good morning" from the
        // briefing). An empty sendResponse aborts the in-flight TTS — that is what
        // cut the briefing off right as the HUD swapped in.
        if (!signal.aborted && speaking) {
          console.log(
            `[speech-engine] echo ignored (hold during playback): ${raw.trim().slice(0, 160)}`,
          );
          return;
        }
        // Every other ignored transcript must get a response. Skipping drops the
        // ElevenLabs session, which leaves the browser mic captions alive.
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
      // Daily briefing must win over Agenda ear. With the ear armed, turns go
      // through the calendar LLM (situational tools, no play_daily_briefing) —
      // which is how "brief me" was answering with aurora / earthquakes.
      const briefingKind = await briefingController()
        .detectIntent(text)
        .catch(() => "none" as const);
      const preferBriefing = briefingKind !== "none";
      const ear = preferBriefing ? null : currentAgendaEar();
      let agendaReply: string | null = null;
      if (ear) {
        console.log(`[speech-engine] agenda user: ${text.slice(0, 160)}`);
        try {
          agendaReply = await answerAgendaTurn({ text, view: ear.view, unified: ear.unified, date: ear.date });
        } catch (err) {
          agendaReply = err instanceof Error ? err.message : "I couldn't read the calendar.";
        }
      } else if (!preferBriefing) {
        try {
          agendaReply = await answerLooseScheduleTurn(text);
        } catch (err) {
          agendaReply = err instanceof Error ? err.message : "I couldn't read the calendar.";
        }
        if (agendaReply !== null) console.log(`[speech-engine] schedule user: ${text.slice(0, 160)}`);
      } else {
        console.log(`[speech-engine] briefing intent (${briefingKind}): ${text.slice(0, 160)}`);
      }
      if (agendaReply !== null) {
        if (epoch !== replyEpoch || signal.aborted) return;
        if (!agendaReply.trim()) agendaReply = "I don't have an answer for that.";
        memory.lastAssistant = agendaReply;
        if (agendaReply.trim()) memory.recentSpoken = agendaReply.trim();
        memory.echoGuardUntil = repliesHushed ? 0 : Date.now() + playbackTailMs(agendaReply);
        turnMemory.set(key, memory);
        try {
          await session.sendResponse(agendaReply.trim() ? agendaReply : "");
        } catch (err) {
          console.error("[speech-engine] agenda speak failed:", err);
        }
        return;
      }
      console.log(`[speech-engine] user: ${text.slice(0, 160)}`);
      noteConversationTurn("user", text);
      void appendLive2ConversationTurn({ role: "user", text, source: "voice" }).catch((err) =>
        console.warn("[speech-engine] conversation history (user) failed:", err),
      );
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
        if (reply.trim()) {
          noteConversationTurn("assistant", reply);
          void appendLive2ConversationTurn({
            role: "assistant",
            text: reply,
            source: "voice",
          }).catch((err) =>
            console.warn("[speech-engine] conversation history (assistant) failed:", err),
          );
        }
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
