import {
  createId,
  CONTROL_STUDIO_LIGHTS_TOOL,
  DELEGATE_TASK_TOOL,
  GET_WEATHER_FORECAST_TOOL,
  REMEMBER_MEMORY_TOOL,
  UPDATE_REMINDER_TOOL,
  type AudioFrame,
  type LatencyMarkName,
  type MultiContextTTSSession,
  type PersonaContext,
  type SttTurnEvent,
  type StreamingSTTSession,
  type TaskCategory,
  type UserConfiguration,
  type VadSignal,
} from "@alfred/contracts";
import type { Clock } from "./clock.js";
import type { EventLedger } from "./event-ledger.js";
import type { BackchannelClassifier, InterruptionArbiter } from "./interruption.js";
import { HeuristicBackchannelClassifier, RuleBasedInterruptionArbiter } from "./interruption.js";
import type { MediaPort, UiCommand, UiLayout } from "./media-port.js";
import { NullMediaPort } from "./media-port.js";
import type {
  AgentRouterPort,
  DueReminderSummary,
  MemoryControllerPort,
  ProviderRegistryPort,
  ReminderPort,
  StudioLightsPort,
  StructuredMemoryPort,
  WeatherForecastPort,
} from "./ports.js";
import { PromptAssembler } from "./prompt-assembler.js";
import { resolveReminderMatch } from "./reminder-match.js";
import type { ResponseLedger } from "./response-ledger.js";
import type { ConversationStateMachine } from "./state-machine.js";
import {
  extractBargeInText,
  hasInterruptCue,
  isConfidentBargeIn,
  isEchoTranscript,
  looksIncompleteInterrupt,
  normalizeForEcho,
} from "./echo-filter.js";
import { revealMarkdownBySpeechProgress, stripMarkdownForSpeech } from "./speech-text.js";
import { SelfVoiceGate } from "./self-voice.js";
import { looksLikeDocsIngestTask } from "./docs-ingest-intent.js";
import { looksLikeXIngestTask } from "./x-ingest-intent.js";
import { looksLikeStudioLightsTask, parseStudioLightIntent } from "./studio-lights-intent.js";
import { looksLikeWeatherTask, parseWeatherIntent } from "./weather-intent.js";

/** Structural port for Daily Briefing (implemented by @alfred/briefing). */
export type BriefingVoiceDecision =
  | { action: "play"; speech: string }
  | { action: "decline"; speech: string }
  | { action: "chat"; appendOffer: boolean; systemHint?: string };

export interface BriefingVoicePort {
  handleUserTurn(text: string): Promise<BriefingVoiceDecision>;
  readonly offerCloser: string;
}

export interface VoiceSessionDeps {
  sessionId: string;
  profileId: string;
  config: UserConfiguration;
  clock: Clock;
  events: EventLedger;
  fsm: ConversationStateMachine;
  responseLedger: ResponseLedger;
  providers: ProviderRegistryPort;
  memory: MemoryControllerPort;
  agents: AgentRouterPort;
  media?: MediaPort;
  /** Always-on SOUL / IDENTITY / USER bootstrap (OpenClaw-style). */
  personaContext?: PersonaContext;
  /** Optional Stage-1 daily briefing offer + play. */
  briefing?: BriefingVoicePort;
  /** Optional due-reminder complete/dismiss/snooze from conversation. */
  reminders?: ReminderPort;
  /** Optional structured Entity/Assertion writes from conversation. */
  structuredMemory?: StructuredMemoryPort;
  /** Optional live weather forecast for conversational asks. */
  weather?: WeatherForecastPort;
  /** Optional local Elgato Key Light control. */
  lights?: StudioLightsPort;
  backchannelClassifier?: BackchannelClassifier;
  interruptionArbiter?: InterruptionArbiter;
  /** Injected streaming STT for tests; otherwise opened from registry. */
  sttSessionFactory?: () => Promise<StreamingSTTSession>;
  ttsSessionFactory?: () => Promise<MultiContextTTSSession>;
}

/**
 * Event-driven voice turn path. Flux/LiveKit emit evidence; this owns policy.
 */
export class VoiceSessionController {
  private readonly media: MediaPort;
  private readonly promptAssembler = new PromptAssembler();
  private readonly backchannelClassifier: BackchannelClassifier;
  private readonly interruptionArbiter: InterruptionArbiter;

  private sttSession?: StreamingSTTSession;
  private ttsSession?: MultiContextTTSSession;
  private running = false;
  private unsubAudio?: () => void;
  private unsubVad?: () => void;
  private unsubUi?: () => void;
  /** Client layout: chat is text-first (no STT auto-commit). */
  private uiLayout: UiLayout = "voice";
  /** Chat-layout hold-to-transcribe into the composer (never commits). */
  private dictating = false;
  /** Client muted mic — drop inbound audio and ignore STT commits. */
  private micMuted = false;
  /** Whether the in-flight / pending user turn should be spoken. */
  private pendingUserSpeak?: boolean;
  private pendingUserSource?: "stt.end_of_turn" | "text";
  private lastCaptionRevealMs = 0;
  private pendingCaptionReveal?: string;

  private partialText = "";
  private provisionalResponseId?: string;
  private provisionalAbort?: AbortController;
  /** User text the in-flight provisional was started for (reuse only if EOT matches). */
  private provisionalForText = "";
  /** Whether that provisional retrieve already included durable facts/notes. */
  private provisionalHadDurableMemory = false;
  /** Settles when the EagerEOT LLM stream finishes (or is aborted). */
  private provisionalStream?: Promise<void>;
  /** Cached Elgato inventory line — discovery is too slow to run every turn. */
  private lightsHintCache?: { atMs: number; text?: string };
  private readonly lightsHintTtlMs = 60_000;
  private activeContextId?: string;
  private activeResponseId?: string;
  private isSpeaking = false;
  /** True while a committed turn is generating/speaking — serialize turns. */
  private turnInFlight = false;
  /** Client pressed Stop — skip speaking the in-flight reply (no barge-in turn). */
  private suppressSpeak = false;
  /** Latest non-echo user text waiting while a turn is in flight. */
  private pendingUserText?: string;
  /** Cut TTS on partial interrupt; wait for EOT before committing the ask. */
  private bargeInListening = false;
  private bargeInDraft?: string;
  /** Aborts in-flight TTS when the user barges in. */
  private speakAbort?: AbortController;
  /** Recent assistant TTS text — used to ignore mic STT that is speaker echo. */
  private lastAssistantSpeech = "";
  /** User turn currently being answered (STT often re-hears it). */
  private lastUserTurn = "";
  /**
   * In-session chat history for LLM prompts (deixis: "yes", "that", etc.).
   * Distinct from long-term memory retrieve.
   */
  private recentTurns: { role: "user" | "assistant"; text: string }[] = [];
  private readonly maxRecentTurns = 20;
  /** Apply echo matching until this clock time (ms) after TTS ends. */
  private echoGuardUntilMs = 0;
  private latencyMarks = new Map<LatencyMarkName, number>();
  /** How long after TTS to keep matching mic STT against assistant speech. */
  private readonly echoCooldownMs = Number(process.env.ALFRED_ECHO_COOLDOWN_MS ?? 2500);
  /** Mic-vs-TTS PCM gate — drops self-echo before Deepgram. */
  private readonly selfVoice = new SelfVoiceGate({
    nowMs: () => this.deps.clock.now(),
  });
  private lastUserTranscriptPublishMs = 0;
  private lastPublishedUserTranscript = "";

  constructor(private readonly deps: VoiceSessionDeps) {
    this.media = deps.media ?? new NullMediaPort();
    this.backchannelClassifier = deps.backchannelClassifier ?? new HeuristicBackchannelClassifier();
    this.interruptionArbiter = deps.interruptionArbiter ?? new RuleBasedInterruptionArbiter();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.sttSession = await this.openSttSession();

    this.ttsSession = this.deps.ttsSessionFactory
      ? await this.deps.ttsSessionFactory()
      : await this.openTtsFromRegistry();

    this.unsubAudio = this.media.onAudioFrame((frame) => {
      void this.onAudioFrame(frame);
    });
    this.unsubVad = this.media.onVad((signal) => {
      void this.onVad(signal);
    });
    this.unsubUi = this.media.onUiCommand((command) => {
      this.handleUiCommand(command);
    });

    void this.consumeSttEvents();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unsubAudio?.();
    this.unsubVad?.();
    this.unsubUi?.();
    this.unsubUi = undefined;
    this.provisionalAbort?.abort({ reason: "session_termination" });
    await this.sttSession?.close();
    await this.ttsSession?.close();
    this.sttSession = undefined;
    this.ttsSession = undefined;
  }

  /** Test helper: inject STT events without audio. */
  async handleSttEvent(event: SttTurnEvent): Promise<void> {
    await this.onSttEvent(event);
  }

  /** Client typed send (or test helper): same session, no TTS. */
  async handleUserText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.provisionalAbort?.abort({ reason: "superseded_generation" });
    this.provisionalResponseId = undefined;
    if (this.isSpeaking || this.activeContextId) {
      await this.stopAssistantPlayback("text_supersede");
    }

    if (this.turnInFlight) {
      this.pendingUserText = trimmed;
      this.pendingUserSpeak = false;
      this.pendingUserSource = "text";
      return;
    }

    this.turnInFlight = true;
    this.lastUserTurn = trimmed;
    this.pendingUserText = undefined;
    this.bargeInListening = false;
    this.bargeInDraft = undefined;
    try {
      await this.runCommittedTurn(trimmed, { source: "text", speak: false });
    } catch (err) {
      console.error("[voice] runCommittedTurn (text) failed:", err);
    }
  }

  /** Client layout / dictate / text / stop / mute commands from the media port. */
  handleUiCommand(command: UiCommand): void {
    if (command.type === "layout") {
      this.uiLayout = command.layout;
      if (command.layout === "voice") this.dictating = false;
      return;
    }
    if (command.type === "dictate") {
      this.dictating = command.active && this.uiLayout === "chat";
      return;
    }
    if (command.type === "mute") {
      this.micMuted = command.muted;
      if (command.muted) {
        this.partialText = "";
        this.bargeInListening = false;
        this.bargeInDraft = undefined;
      }
      return;
    }
    if (command.type === "stop") {
      void this.handleClientStop();
      return;
    }
    void this.handleUserText(command.text);
  }

  /** Immediate silence from the UI — cut TTS, do not queue a barge-in ask. */
  private async handleClientStop(): Promise<void> {
    this.provisionalAbort?.abort({ reason: "user_interruption" });
    this.provisionalResponseId = undefined;
    this.bargeInListening = false;
    this.bargeInDraft = undefined;
    // Snapshot before stopAssistantPlayback clears isSpeaking — otherwise Shhh
    // mid-speech wrongly sets suppressSpeak and poisons the *next* user turn.
    const wasSpeaking = this.isSpeaking || Boolean(this.activeContextId);
    if (wasSpeaking) {
      await this.stopAssistantPlayback("ui_stop");
    }
    // Only suppress deliver if we cut generation before TTS started.
    if (this.turnInFlight && !wasSpeaking) {
      this.suppressSpeak = true;
    }
  }

  getLatencyMarks(): ReadonlyMap<LatencyMarkName, number> {
    return this.latencyMarks;
  }

  private async openSttSession(): Promise<StreamingSTTSession> {
    if (this.deps.sttSessionFactory) {
      return this.deps.sttSessionFactory();
    }
    return this.openSttFromRegistry();
  }

  private async openSttFromRegistry(): Promise<StreamingSTTSession> {
    const id = this.deps.config.pipeline.sttPriority?.orderedProviderIds[0] ?? "stt.deepgram.flux";
    const stt = this.deps.providers.getStt(id);
    if (!stt.openSession) {
      throw new Error(`STT provider ${id} does not support openSession`);
    }
    return stt.openSession({
      eagerEotThreshold: 0.4,
      sampleRate: 16_000,
    });
  }

  private async openTtsFromRegistry(): Promise<MultiContextTTSSession> {
    const id =
      this.deps.config.pipeline.ttsPriority?.orderedProviderIds[0] ?? "tts.elevenlabs.flash_v2_5";
    const tts = this.deps.providers.getTts(id);
    if (!tts.openMultiContextSession) {
      throw new Error(`TTS provider ${id} does not support openMultiContextSession`);
    }
    return tts.openMultiContextSession({
      voiceId: "qXcNpxDCD6dKvASibF0r",
      sampleRate: 24_000,
    });
  }

  private inEchoWindow(): boolean {
    return this.isSpeaking || this.deps.clock.now() < this.echoGuardUntilMs;
  }

  private armEchoGuard(extraMs?: number): void {
    const ms = extraMs ?? this.echoCooldownMs;
    this.echoGuardUntilMs = Math.max(this.echoGuardUntilMs, this.deps.clock.now() + ms);
    this.selfVoice.armCooldown(ms);
  }

  /** Mic STT that matches assistant speech or the user turn being answered → echo. */
  private shouldIgnoreAsEcho(text: string | undefined): boolean {
    if (!this.inEchoWindow() && !this.turnInFlight) return false;
    if (!text?.trim()) return this.isSpeaking || this.turnInFlight;
    return isEchoTranscript({
      heard: text,
      assistantSpeech: this.lastAssistantSpeech,
      userTurn: this.lastUserTurn,
      aggressiveShort: true,
    });
  }

  private echoInput(text: string) {
    return {
      heard: text,
      assistantSpeech: this.lastAssistantSpeech,
      userTurn: this.lastUserTurn,
    };
  }

  private isRealBargeIn(text: string | undefined): boolean {
    if (!text?.trim()) return false;
    // While answering, only explicit interrupt cues may cut in. Garbled self-echo
    // ("You're Devon James…" → "You would debit James…") looks "novel" too often.
    if (this.isSpeaking || this.turnInFlight || this.bargeInListening) {
      const cleaned = extractBargeInText(this.echoInput(text));
      if (!hasInterruptCue(text) && !hasInterruptCue(cleaned)) return false;
    }
    return isConfidentBargeIn(this.echoInput(text));
  }

  /**
   * Substantial new user speech while we are busy — not assistant echo, not a
   * backchannel. Used so follow-ups like answering "let's hear it" are queued
   * instead of dropped for lacking "hold on"/"stop" interrupt cues.
   */
  private isNovelUserTurn(text: string | undefined): boolean {
    if (!text?.trim()) return false;
    if (
      isEchoTranscript({
        heard: text,
        assistantSpeech: this.lastAssistantSpeech,
        userTurn: this.lastUserTurn,
        aggressiveShort: true,
      })
    ) {
      return false;
    }
    const tokens = normalizeForEcho(text)
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    const content = tokens.filter((t) => !NOVEL_TURN_STOPWORDS.has(t));
    return content.length >= 3;
  }

  /** Accept barge-in / follow-up while generating or speaking. */
  private shouldAcceptBusyTurn(text: string | undefined): boolean {
    return this.isRealBargeIn(text) || this.isNovelUserTurn(text);
  }

  /** Strip leading assistant-echo glued onto an interrupt before committing it. */
  private cleanBargeInText(text: string): string {
    return extractBargeInText(this.echoInput(text));
  }

  private async onAudioFrame(frame: AudioFrame): Promise<void> {
    // Client Mute (or a stuck LiveKit publish) must not keep feeding STT.
    if (this.micMuted) return;
    // Drop mic frames that look like speaker echo of our own TTS (before STT).
    // Uncorrelated barge-ins still reach Deepgram for transcript interrupt cues.
    if (this.selfVoice.isSelfEcho(frame)) {
      if (process.env.ALFRED_LOG_VOICE === "1") {
        console.log("[voice] self-voice drop (mic ≈ TTS)");
      }
      return;
    }
    this.mark("last_user_audio_at");
    await this.sttSession?.pushAudio(frame);
  }

  /** Push user STT to the client HUD (partials throttled). */
  private async publishUserTranscriptUi(text: string, kind: "partial" | "final"): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const now = this.deps.clock.now();
    if (kind === "partial") {
      if (now - this.lastUserTranscriptPublishMs < 80) return;
      if (trimmed === this.lastPublishedUserTranscript) return;
    }
    this.lastPublishedUserTranscript = trimmed;
    this.lastUserTranscriptPublishMs = now;
    await this.media.publishUserTranscript({ type: kind, text: trimmed });
  }

  private async onVad(signal: VadSignal): Promise<void> {
    // Energy VAD alone can't distinguish echo from barge-in; interruption is STT-driven.
    void signal;
  }

  private async stopAssistantPlayback(reason: string): Promise<void> {
    this.mark("interruption_detected_at");
    this.speakAbort?.abort();
    this.isSpeaking = false;
    this.selfVoice.clear();
    await this.media.stopPlayback(reason);
    await this.media.publishCaption({ type: "end", reason });
    this.mark("audio_stopped_at");
    if (this.activeContextId) {
      const ctx = this.activeContextId;
      this.activeContextId = undefined;
      try {
        await this.ttsSession?.closeContext(ctx, reason);
      } catch {
        /* ignore */
      }
    }
    console.log(`[voice] barge-in stop (${reason})`);
  }

  /**
   * Cut TTS on barge-in evidence. Only queue a commit once the interrupt looks complete
   * (eager/EOT) — partials like "Um, can you" must not become their own turns.
   */
  private async handleBargeIn(text: string, source: string): Promise<void> {
    if (!this.shouldAcceptBusyTurn(text)) return;
    const cleaned = this.cleanBargeInText(text);
    this.bargeInListening = true;
    this.bargeInDraft = this.pickRicherUtterance(cleaned, this.bargeInDraft);

    this.provisionalAbort?.abort({ reason: "user_interruption" });
    this.provisionalResponseId = undefined;
    if (this.isSpeaking || this.activeContextId) {
      await this.stopAssistantPlayback("stt_barge_in");
    }

    // Partials only cut audio — wait for a fuller transcript to commit.
    if (source === "partial_transcript" || source === "start_of_turn") {
      console.log(
        `[voice] barge-in cut via ${source} (waiting for EOT): "${cleaned.slice(0, 120)}"`,
      );
      return;
    }

    if (
      this.sameUtterance(cleaned, this.pendingUserText) ||
      this.sameUtterance(cleaned, this.lastUserTurn)
    ) {
      return;
    }

    // Eager/resumed with an incomplete ask — keep listening.
    if (
      (source === "eager_end_of_turn" || source === "turn_resumed") &&
      looksIncompleteInterrupt(cleaned)
    ) {
      console.log(
        `[voice] barge-in draft via ${source} (incomplete, waiting): "${cleaned.slice(0, 120)}"`,
      );
      return;
    }

    console.log(`[voice] barge-in queued via ${source}: "${cleaned.slice(0, 120)}"`);
    this.pendingUserText = this.pickRicherUtterance(cleaned, this.bargeInDraft);
  }

  private sameUtterance(a: string | undefined, b: string | undefined): boolean {
    if (!a?.trim() || !b?.trim()) return false;
    const na = a
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const nb = b
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (na === nb) return true;
    return na.includes(nb) || nb.includes(na);
  }

  private pickRicherUtterance(a: string, b: string | undefined): string {
    if (!b?.trim()) return a;
    if (a.trim().length >= b.trim().length) return a;
    return b;
  }

  private takeBargeInCommitText(fallback: string): string {
    const cleaned = this.cleanBargeInText(fallback);
    const best = this.pickRicherUtterance(cleaned, this.bargeInDraft);
    this.bargeInDraft = undefined;
    this.bargeInListening = false;
    return best;
  }

  private async consumeSttEvents(): Promise<void> {
    // Deepgram (and other streaming STTs) close after idle / client disconnect.
    // Keep reopening while the voice agent is still running so a second ENGAGE /
    // Speak session is not silently deaf.
    while (this.running) {
      let session = this.sttSession;
      if (!session) {
        try {
          session = await this.openSttSession();
          this.sttSession = session;
          console.log("[voice] STT session open");
        } catch (err) {
          console.error("[voice] STT open failed; retrying…", err);
          await this.delay(500);
          continue;
        }
      }

      try {
        for await (const event of session.events()) {
          if (!this.running) return;
          await this.onSttEvent(event);
        }
      } catch (err) {
        if (this.running) {
          console.error("[voice] STT event loop error:", err);
        }
      }

      if (!this.running) return;

      console.warn("[voice] STT session ended; reconnecting…");
      if (this.sttSession === session) {
        await session.close().catch(() => undefined);
        this.sttSession = undefined;
      }
      await this.delay(250);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async onSttEvent(event: SttTurnEvent): Promise<void> {
    if (process.env.ALFRED_LOG_VOICE === "1" || process.env.ALFRED_LOG_STT === "1") {
      console.log(`[voice] stt ${event.type}${event.text ? `: ${event.text.slice(0, 100)}` : ""}`);
    }

    if (this.micMuted) return;

    if (this.uiLayout === "chat") {
      await this.onChatLayoutStt(event);
      return;
    }

    const eventText =
      event.type === "partial_transcript" ||
      event.type === "start_of_turn" ||
      event.type === "eager_end_of_turn" ||
      event.type === "turn_resumed" ||
      event.type === "end_of_turn"
        ? (event.text ?? this.partialText)
        : undefined;

    // Barge-in / follow-up BEFORE echo-ignore — STT often glues echo + interrupt.
    if (
      (this.isSpeaking || this.turnInFlight) &&
      (event.type === "eager_end_of_turn" ||
        event.type === "end_of_turn" ||
        event.type === "turn_resumed" ||
        event.type === "partial_transcript") &&
      this.shouldAcceptBusyTurn(eventText)
    ) {
      await this.handleBargeIn(eventText ?? this.partialText, event.type);
      if (event.type !== "end_of_turn") {
        // Wait for final EOT to commit the interrupting turn (partial/eager just cut audio).
        if (event.type === "eager_end_of_turn" || event.type === "turn_resumed") {
          this.partialText = this.cleanBargeInText(eventText ?? this.partialText);
        }
        return;
      }
      // end_of_turn falls through to commitEndOfTurn with cleaned pending already set.
    }

    if (
      this.shouldIgnoreAsEcho(eventText) &&
      (event.type === "start_of_turn" ||
        event.type === "partial_transcript" ||
        event.type === "eager_end_of_turn" ||
        event.type === "turn_resumed" ||
        event.type === "end_of_turn")
    ) {
      if (process.env.ALFRED_LOG_VOICE === "1" || process.env.ALFRED_LOG_STT === "1") {
        console.log(`[voice] ignoring echo stt ${event.type}: "${(eventText ?? "").slice(0, 80)}"`);
      }
      return;
    }

    switch (event.type) {
      case "start_of_turn":
        this.mark("speech_started_at");
        this.partialText = event.text ?? "";
        if (!this.shouldIgnoreAsEcho(this.partialText)) {
          await this.publishUserTranscriptUi(this.partialText, "partial");
        }
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "stt.start_of_turn",
          payload: { text: this.partialText },
        });
        if (this.deps.fsm.getState() === "Listening" || this.deps.fsm.getState() === "Idle") {
          if (this.deps.fsm.canTransition("UserSpeechDetected")) {
            await this.deps.fsm.transition("UserSpeechDetected", "stt.start_of_turn");
          } else {
            await this.deps.fsm.force("UserSpeechDetected", "stt.start_of_turn");
          }
        }
        break;

      case "partial_transcript":
        this.partialText = event.text ?? this.partialText;
        if (this.shouldIgnoreAsEcho(this.partialText)) return;
        await this.publishUserTranscriptUi(this.partialText, "partial");
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "stt.partial_transcript",
          payload: { text: this.partialText },
        });
        break;

      case "eager_end_of_turn":
        this.mark("eager_eot_at");
        this.partialText = event.text ?? this.partialText;
        if (this.turnInFlight) {
          // Generating or speaking — don't start a second provisional reply.
          if (this.shouldAcceptBusyTurn(this.partialText)) {
            this.pendingUserText = this.partialText;
            await this.publishUserTranscriptUi(this.partialText, "partial");
          }
          return;
        }
        if (!this.shouldIgnoreAsEcho(this.partialText)) {
          await this.publishUserTranscriptUi(this.partialText, "partial");
        }
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "stt.eager_eot",
          payload: {
            text: this.partialText,
            confidence: event.eagerEotConfidence ?? event.confidence,
          },
        });
        if (this.deps.lights && looksLikeStudioLightsTask(this.partialText)) {
          // Light commands execute on EndOfTurn; a tool-less provisional draft
          // would get spoken as "I don't have that action."
          break;
        }
        if (this.deps.weather && looksLikeWeatherTask(this.partialText)) {
          // Weather executes on EndOfTurn via short-circuit; provisional has no tools
          // and invents "which location?" instead of using home BRIEFING_*.
          break;
        }
        await this.beginProvisionalGeneration(this.partialText);
        break;

      case "turn_resumed":
        this.partialText = event.text ?? this.partialText;
        if (this.turnInFlight) {
          if (this.shouldAcceptBusyTurn(this.partialText)) {
            this.pendingUserText = this.partialText;
            await this.publishUserTranscriptUi(this.partialText, "partial");
          }
          return;
        }
        if (!this.shouldIgnoreAsEcho(this.partialText)) {
          await this.publishUserTranscriptUi(this.partialText, "partial");
        }
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "stt.turn_resumed",
          payload: { text: this.partialText },
        });
        await this.handleTurnResumed(this.partialText);
        break;

      case "end_of_turn":
        this.mark("final_eot_at");
        this.partialText = event.text ?? this.partialText;
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "stt.end_of_turn",
          payload: { text: this.partialText },
        });
        await this.commitEndOfTurn(this.partialText);
        break;

      case "error":
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "error",
          payload: { source: "stt", error: event.error, failureClass: event.failureClass },
        });
        break;
    }
  }

  /** Chat layout: STT fills the composer while dictating; never auto-commits. */
  private async onChatLayoutStt(event: SttTurnEvent): Promise<void> {
    if (!this.dictating) return;
    switch (event.type) {
      case "start_of_turn":
      case "partial_transcript":
      case "eager_end_of_turn":
      case "turn_resumed":
        this.partialText = event.text ?? this.partialText;
        await this.publishUserTranscriptUi(this.partialText, "partial");
        break;
      case "end_of_turn":
        this.partialText = event.text ?? this.partialText;
        await this.publishUserTranscriptUi(this.partialText, "final");
        break;
      default:
        break;
    }
  }

  private async beginProvisionalGeneration(text: string): Promise<void> {
    if (!text.trim()) return;
    if (this.deps.lights && looksLikeStudioLightsTask(text)) return;
    if (this.deps.weather && looksLikeWeatherTask(text)) return;
    // Do not commit user turn yet — provisional segment only.
    this.provisionalAbort?.abort({ reason: "superseded_generation" });
    this.provisionalAbort = new AbortController();
    const responseId = this.deps.responseLedger.beginResponse(
      this.deps.sessionId,
      createId("turn_prov"),
    );
    this.provisionalResponseId = responseId;
    this.provisionalForText = text.trim();
    this.provisionalHadDurableMemory = false;
    this.provisionalStream = undefined;

    await this.deps.events.emit({
      sessionId: this.deps.sessionId,
      type: "turn.provisional",
      responseId,
      payload: { text },
    });

    if (this.deps.fsm.canTransition("GeneratingResponse")) {
      await this.deps.fsm.transition("GeneratingResponse", "stt.eager_eot");
    } else {
      await this.deps.fsm.force("GeneratingResponse", "stt.eager_eot");
    }

    // Same context as the committed path so EagerEOT drafts are reusable —
    // regenerating after every durable-memory hit was killing first-audio latency.
    const [memory, dueReminders, extraSystem] = await Promise.all([
      this.deps.memory.retrieve({
        text,
        profileId: this.deps.profileId,
        sessionId: this.deps.sessionId,
        limit: 8,
      }),
      this.loadDueReminders(),
      this.studioLightsHint(),
    ]);
    this.provisionalHadDurableMemory = memory.items.some((m) => {
      const kind = m.provenance?.kind;
      return kind === "fact" || kind === "note";
    });

    const prompt = this.promptAssembler.assemble({
      systemInstructions: this.deps.config.systemInstructions,
      currentUserTurn: text,
      recentConversation: this.recentConversationForPrompt(),
      personaContext: this.deps.personaContext,
      retrievedMemory: memory.items,
      mode: "initial",
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: this.voiceCapabilities(),
      extraSystem,
      dueReminders,
      existingResponseState: {
        spokenText: "",
        unspokenText: "",
        proposedText: "",
        isGenerating: true,
        isSpeaking: false,
      },
    });

    this.provisionalStream = this.streamProvisionalLlm(
      prompt.messages,
      responseId,
      this.provisionalAbort.signal,
    );
  }

  private async streamProvisionalLlm(
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[],
    responseId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const llmId =
      this.deps.config.pipeline.llmPriority?.orderedProviderIds[0] ?? "llm.openai.terra";
    const llm = this.deps.providers.getLlm(llmId);
    let first = true;
    try {
      for await (const chunk of llm.generateStream({
        messages,
        signal,
        modelPreset: "conversational",
        reasoningEffort: "none",
      })) {
        if (signal.aborted) return;
        if (chunk.type === "token" && chunk.text) {
          if (first) {
            this.mark("first_llm_token_at");
            first = false;
          }
          await this.deps.responseLedger.appendProposed(responseId, chunk.text);
        }
      }
    } catch {
      // Superseded or cancelled — ignore.
    }
  }

  private async handleTurnResumed(text: string): Promise<void> {
    // Cancel provisional generation; treat as continuation/addendum evidence.
    this.provisionalAbort?.abort({ reason: "superseded_generation" });
    if (this.provisionalResponseId) {
      const unspoken = this.deps.responseLedger.getUnspokenRemainder(this.provisionalResponseId);
      const proposed = this.deps.responseLedger.getProposedText(this.provisionalResponseId);
      const abandon = unspoken || proposed;
      if (abandon) {
        await this.deps.responseLedger.abandon(
          this.provisionalResponseId,
          abandon,
          "superseded_generation",
        );
      }
    }
    this.provisionalResponseId = undefined;
    this.provisionalForText = "";
    this.provisionalHadDurableMemory = false;
    this.provisionalStream = undefined;
    this.partialText = text;
    await this.deps.events.emit({
      sessionId: this.deps.sessionId,
      type: "turn.addendum",
      payload: { text, kind: "turn_resumed_before_speech" },
    });
  }

  private async commitEndOfTurn(
    text: string,
    opts?: { /** Drain a queued barge-in after the prior turn ends. */ force?: boolean },
  ): Promise<void> {
    // While a turn is actively generating/speaking: queue real follow-ups, drop echo.
    if (!opts?.force && (this.turnInFlight || this.isSpeaking)) {
      if (!this.shouldAcceptBusyTurn(text) && !this.bargeInListening) {
        console.log(`[voice] skip commit (busy): "${text.slice(0, 100)}"`);
        return;
      }
      if (this.shouldAcceptBusyTurn(text) || this.bargeInListening) {
        await this.handleBargeIn(text, "end_of_turn");
        // If the interrupt is now complete, pendingUserText is set for finally/drain.
        // If still incomplete, keep bargeInListening until a richer EOT.
      }
      return;
    }

    // We already cut TTS for an interrupt — commit the full ask now (not the early partial).
    if (!opts?.force && this.bargeInListening) {
      const commitText = this.takeBargeInCommitText(text);
      if (!commitText.trim()) return;
      this.turnInFlight = true;
      this.lastUserTurn = commitText;
      this.pendingUserText = undefined;
      await this.publishUserTranscriptUi(commitText, "final");
      console.log(`[voice] EndOfTurn committed: "${commitText.slice(0, 160)}"`);
      void this.runCommittedTurn(commitText).catch((err) => {
        console.error("[voice] runCommittedTurn failed:", err);
      });
      return;
    }

    // Idle after TTS: drop only transcripts that look like echo — not every
    // utterance that fails mid-speech barge-in heuristics. Longer memory-grounded
    // replies made that gate drop most short follow-ups for ~2.5s (every-other turn).
    if (!opts?.force && this.shouldIgnoreAsEcho(text)) {
      if (process.env.ALFRED_LOG_VOICE === "1") {
        console.log(`[voice] skip commit (echo): "${text.slice(0, 80)}"`);
      }
      return;
    }

    this.turnInFlight = true;
    this.lastUserTurn = text;
    this.pendingUserText = undefined;
    this.bargeInListening = false;
    this.bargeInDraft = undefined;
    await this.publishUserTranscriptUi(text, "final");
    console.log(`[voice] EndOfTurn committed: "${text.slice(0, 160)}"`);

    // Run generate+speak in the background so the STT event loop can still hear barge-ins.
    void this.runCommittedTurn(text).catch((err) => {
      console.error("[voice] runCommittedTurn failed:", err);
    });
  }

  private async runCommittedTurn(
    text: string,
    opts?: { source?: "stt.end_of_turn" | "text"; speak?: boolean },
  ): Promise<void> {
    const source = opts?.source ?? "stt.end_of_turn";
    const speak = opts?.speak ?? true;
    const turnId = createId("turn");
    await this.deps.events.emit({
      sessionId: this.deps.sessionId,
      type: "turn.committed",
      turnId,
      payload: { text, source },
    });

    // Journal the user turn without blocking first-audio; retrieve/briefing below matter more.
    void this.deps.memory
      .commitTurn({
        profileId: this.deps.profileId,
        sessionId: this.deps.sessionId,
        turnId,
        role: "user",
        text,
        metadata: {},
      })
      .catch((err) => console.error("[voice] commitTurn (user) failed:", err));
    this.pushRecentTurn("user", text);

    // Briefing + memory in parallel — both were sequential on the hot path.
    const [briefingDecision, memory] = await Promise.all([
      this.deps.briefing
        ? this.deps.briefing.handleUserTurn(text).catch((err) => {
            console.error("[voice] briefing handleUserTurn failed:", err);
            return undefined;
          })
        : Promise.resolve(undefined),
      this.deps.memory.retrieve({
        text,
        profileId: this.deps.profileId,
        sessionId: this.deps.sessionId,
        limit: 8,
      }),
    ]);

    if (briefingDecision?.action === "play" || briefingDecision?.action === "decline") {
      try {
        this.provisionalAbort?.abort({ reason: "briefing_short_circuit" });
        const responseId = this.deps.responseLedger.beginResponse(this.deps.sessionId, turnId);
        this.provisionalResponseId = responseId;
        const assistantText = briefingDecision.speech;
        if (this.pendingUserText || this.bargeInListening || this.suppressSpeak) {
          if (this.suppressSpeak) this.suppressSpeak = false;
          console.log("[voice] skip briefing speak; barge-in pending");
          return;
        }
        await this.deps.responseLedger.commit(responseId, assistantText);
        this.activeResponseId = responseId;
        console.log(`[voice] speaking briefing: "${assistantText.slice(0, 160)}"`);
        await this.deliverAssistant(responseId, assistantText, speak);
        await this.deps.memory.commitTurn({
          profileId: this.deps.profileId,
          sessionId: this.deps.sessionId,
          turnId: createId("turn"),
          role: "assistant",
          text: assistantText,
          metadata: { responseId, briefing: briefingDecision.action },
        });
        this.pushRecentTurn("assistant", assistantText);
        console.log("[voice] briefing turn playback complete");
        this.provisionalResponseId = undefined;
      } catch (err) {
        console.error("[voice] briefing speak failed:", err);
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "error",
          turnId,
          payload: {
            source: "briefing",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      } finally {
        await this.finishTurn({ speak });
      }
      return;
    }

    if (this.deps.lights) {
      const lightsCommand = parseStudioLightIntent(text);
      if (lightsCommand) {
        try {
          this.provisionalAbort?.abort({ reason: "studio_lights_short_circuit" });
          const responseId = this.deps.responseLedger.beginResponse(this.deps.sessionId, turnId);
          this.provisionalResponseId = responseId;
          const assistantText = await this.deps.lights.control(lightsCommand);
          if (this.pendingUserText || this.bargeInListening || this.suppressSpeak) {
            if (this.suppressSpeak) this.suppressSpeak = false;
            console.log("[voice] skip lights speak; barge-in pending");
            return;
          }
          await this.deps.responseLedger.commit(responseId, assistantText);
          this.activeResponseId = responseId;
          console.log(`[voice] studio lights ${lightsCommand.action}: "${assistantText.slice(0, 160)}"`);
          await this.deliverAssistant(responseId, assistantText, speak);
          await this.deps.memory.commitTurn({
            profileId: this.deps.profileId,
            sessionId: this.deps.sessionId,
            turnId: createId("turn"),
            role: "assistant",
            text: assistantText,
            metadata: { responseId, studioLights: lightsCommand.action },
          });
          this.pushRecentTurn("assistant", assistantText);
          this.provisionalResponseId = undefined;
        } catch (err) {
          console.error("[voice] studio lights failed:", err);
        } finally {
          await this.finishTurn({ speak });
        }
        return;
      }
    }

    if (this.deps.weather) {
      const weatherIntent = parseWeatherIntent(text);
      if (weatherIntent) {
        try {
          this.provisionalAbort?.abort({ reason: "weather_short_circuit" });
          const responseId = this.deps.responseLedger.beginResponse(this.deps.sessionId, turnId);
          this.provisionalResponseId = responseId;
          const assistantText = await this.deps.weather.getForecast({
            location: weatherIntent.location,
            days: weatherIntent.days,
          });
          if (this.pendingUserText || this.bargeInListening || this.suppressSpeak) {
            if (this.suppressSpeak) this.suppressSpeak = false;
            console.log("[voice] skip weather speak; barge-in pending");
            return;
          }
          await this.deps.responseLedger.commit(responseId, assistantText);
          this.activeResponseId = responseId;
          console.log(
            `[voice] weather${weatherIntent.location ? ` (${weatherIntent.location})` : " (home)"}: "${assistantText.slice(0, 160)}"`,
          );
          await this.deliverAssistant(responseId, assistantText, speak);
          await this.deps.memory.commitTurn({
            profileId: this.deps.profileId,
            sessionId: this.deps.sessionId,
            turnId: createId("turn"),
            role: "assistant",
            text: assistantText,
            metadata: {
              responseId,
              weather: weatherIntent.location ? "named" : "home",
            },
          });
          this.pushRecentTurn("assistant", assistantText);
          this.provisionalResponseId = undefined;
        } catch (err) {
          console.error("[voice] weather short-circuit failed:", err);
        } finally {
          await this.finishTurn({ speak });
        }
        return;
      }
    }

    if (looksLikeDocsIngestTask(text)) {
      try {
        this.provisionalAbort?.abort({ reason: "docs_ingest_short_circuit" });
        const responseId = this.deps.responseLedger.beginResponse(this.deps.sessionId, turnId);
        this.provisionalResponseId = responseId;
        const assistantText = "I'll ingest your documentation folder into memory now.";
        void this.deps.agents
          .delegate({
            correlationId: createId("corr"),
            taskDescription: text,
            taskCategory: "research",
            conversationContext: text,
            permissions: ["agent.delegate"],
            requestedOutputFormat: "text",
            confirmationRequired: false,
            timeoutMs: 600_000,
          })
          .catch((err) => console.error("[voice] background docs ingest failed:", err));
        if (this.pendingUserText || this.bargeInListening || this.suppressSpeak) {
          if (this.suppressSpeak) this.suppressSpeak = false;
          console.log("[voice] skip docs ingest speak; barge-in pending");
          return;
        }
        await this.deps.responseLedger.commit(responseId, assistantText);
        this.activeResponseId = responseId;
        await this.deliverAssistant(responseId, assistantText, speak);
        await this.deps.memory.commitTurn({
          profileId: this.deps.profileId,
          sessionId: this.deps.sessionId,
          turnId: createId("turn"),
          role: "assistant",
          text: assistantText,
          metadata: { responseId, docsIngest: true },
        });
        this.pushRecentTurn("assistant", assistantText);
        this.provisionalResponseId = undefined;
      } catch (err) {
        console.error("[voice] docs ingest failed:", err);
      } finally {
        await this.finishTurn({ speak });
      }
      return;
    }

    if (looksLikeXIngestTask(text)) {
      try {
        this.provisionalAbort?.abort({ reason: "x_ingest_short_circuit" });
        const responseId = this.deps.responseLedger.beginResponse(this.deps.sessionId, turnId);
        this.provisionalResponseId = responseId;
        const isUrl = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(text);
        let assistantText: string;
        if (!isUrl) {
          assistantText =
            "I'll ingest your X notes into memory now. New items will show up in today's briefing.";
          void this.deps.agents
            .delegate({
              correlationId: createId("corr"),
              taskDescription: text,
              taskCategory: "research",
              conversationContext: text,
              permissions: ["agent.delegate"],
              requestedOutputFormat: "text",
              confirmationRequired: false,
              timeoutMs: 600_000,
            })
            .catch((err) => console.error("[voice] background X ingest failed:", err));
        } else {
          const result = await this.deps.agents.delegate({
            correlationId: createId("corr"),
            taskDescription: text,
            taskCategory: "research",
            conversationContext: text,
            permissions: ["agent.delegate"],
            requestedOutputFormat: "text",
            confirmationRequired: false,
            timeoutMs: 600_000,
          });
          assistantText =
            result.status === "failed"
              ? result.error || result.output || "I couldn't ingest that X link."
              : result.output || "Saved that X link to memory.";
        }
        if (this.pendingUserText || this.bargeInListening || this.suppressSpeak) {
          if (this.suppressSpeak) this.suppressSpeak = false;
          console.log("[voice] skip X ingest speak; barge-in pending");
          return;
        }
        await this.deps.responseLedger.commit(responseId, assistantText);
        this.activeResponseId = responseId;
        await this.deliverAssistant(responseId, assistantText, speak);
        await this.deps.memory.commitTurn({
          profileId: this.deps.profileId,
          sessionId: this.deps.sessionId,
          turnId: createId("turn"),
          role: "assistant",
          text: assistantText,
          metadata: { responseId, xIngest: true },
        });
        this.pushRecentTurn("assistant", assistantText);
        this.provisionalResponseId = undefined;
      } catch (err) {
        console.error("[voice] X ingest failed:", err);
      } finally {
        await this.finishTurn({ speak });
      }
      return;
    }

    // Memory already retrieved in parallel with briefing above.
    const hasDurableMemory = memory.items.some((m) => {
      const kind = m.provenance?.kind;
      return kind === "fact" || kind === "note";
    });

    const appendOffer = briefingDecision?.action === "chat" && briefingDecision.appendOffer;
    const offerHint = briefingDecision?.action === "chat" ? briefingDecision.systemHint : undefined;

    try {
      let responseId = this.provisionalResponseId;
      let assistantText = responseId ? this.deps.responseLedger.getProposedText(responseId) : "";
      let streamedCaptions = false;

      // EagerEOT may still be awaiting first token when EndOfTurn arrives — wait
      // briefly before deciding the provisional is empty and regenerating.
      if (
        responseId &&
        this.sameUtterance(text, this.provisionalForText) &&
        !assistantText.trim()
      ) {
        assistantText = await this.waitForProposedText(responseId, 1_200);
      }

      const provisionalMatches = this.sameUtterance(text, this.provisionalForText);
      const memoryMissedInProvisional = hasDurableMemory && !this.provisionalHadDurableMemory;
      let shouldRegenerate =
        !responseId ||
        !assistantText.trim() ||
        !provisionalMatches ||
        memoryMissedInProvisional ||
        appendOffer ||
        (this.deps.lights && looksLikeStudioLightsTask(text)) ||
        (this.deps.weather && looksLikeWeatherTask(text));

      if (!shouldRegenerate && responseId) {
        // Wait for the EagerEOT stream to finish — aborting early spoke truncated
        // replies ("Exactly—the last quiet", "Do you mean").
        assistantText = await this.waitForProvisionalComplete(responseId, 8_000);
        if (looksTruncatedAssistantReply(assistantText)) {
          shouldRegenerate = true;
          if (process.env.ALFRED_LOG_VOICE === "1") {
            console.log(
              `[voice] provisional still truncated after wait; regenerating: "${assistantText.slice(0, 80)}"`,
            );
          }
        } else if (process.env.ALFRED_LOG_VOICE === "1") {
          console.log(
            `[voice] reusing provisional draft (${assistantText.length} chars, durableMem=${hasDurableMemory})`,
          );
        }
      }

      if (shouldRegenerate) {
        this.provisionalAbort?.abort({ reason: "superseded_generation" });
        responseId = this.deps.responseLedger.beginResponse(this.deps.sessionId, turnId);
        this.provisionalResponseId = responseId;
        if (process.env.ALFRED_LOG_VOICE === "1") {
          console.log(
            `[voice] regenerating reply (provMatch=${provisionalMatches} memMiss=${memoryMissedInProvisional} offer=${Boolean(appendOffer)})`,
          );
        }
        const systemInstructions = offerHint
          ? `${this.deps.config.systemInstructions}\n\n${offerHint}`
          : this.deps.config.systemInstructions;
        const [dueReminders, extraSystem] = await Promise.all([
          this.loadDueReminders(),
          this.studioLightsHint(),
        ]);
        const availableCapabilities = this.voiceCapabilities();
        const prompt = this.promptAssembler.assemble({
          systemInstructions,
          currentUserTurn: text,
          recentConversation: this.recentConversationForPrompt(),
          personaContext: this.deps.personaContext,
          retrievedMemory: memory.items,
          mode: "initial",
          lateAddenda: [],
          agentResults: [],
          availableCapabilities,
          extraSystem,
          dueReminders,
        });
        assistantText = await this.generateCommitted(prompt.messages, responseId, dueReminders, {
          streamCaptions: !speak,
        });
        streamedCaptions = !speak;
      }

      if (appendOffer && this.deps.briefing) {
        const closer = this.deps.briefing.offerCloser;
        if (!assistantText.includes(closer)) {
          assistantText = `${assistantText.trim()} ${closer}`.trim();
        }
      }

      // Barge-in arrived while we were generating — skip speaking this reply.
      if (this.pendingUserText || this.bargeInListening || this.suppressSpeak) {
        if (this.suppressSpeak) {
          this.suppressSpeak = false;
          console.log("[voice] skip speak; client stop");
        } else {
          console.log(
            this.pendingUserText
              ? "[voice] skip speak; pending barge-in"
              : "[voice] skip speak; waiting for complete interrupt",
          );
        }
        return;
      }

      await this.deps.responseLedger.commit(responseId, assistantText);
      this.activeResponseId = responseId;
      console.log(`[voice] speaking: "${assistantText.slice(0, 160)}"`);
      await this.deliverAssistant(responseId, assistantText, speak, {
        alreadyStreaming: streamedCaptions,
      });
      await this.deps.memory.commitTurn({
        profileId: this.deps.profileId,
        sessionId: this.deps.sessionId,
        turnId: createId("turn"),
        role: "assistant",
        text: assistantText,
        metadata: { responseId },
      });
      this.pushRecentTurn("assistant", assistantText);
      this.provisionalResponseId = undefined;
      this.provisionalForText = "";
      this.provisionalHadDurableMemory = false;
      this.provisionalStream = undefined;
      console.log("[voice] turn playback complete");
    } catch (err) {
      console.error("[voice] commitEndOfTurn failed:", err);
      await this.deps.events.emit({
        sessionId: this.deps.sessionId,
        type: "error",
        turnId,
        payload: {
          source: "commitEndOfTurn",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      await this.finishTurn({ speak });
    }
  }

  private async waitForProposedText(responseId: string, budgetMs: number): Promise<string> {
    // Wall clock — FakeClock used in tests does not advance with setTimeout.
    const started = Date.now();
    while (Date.now() - started < budgetMs) {
      const text = this.deps.responseLedger.getProposedText(responseId);
      if (text.trim()) return text;
      await this.delay(40);
    }
    return this.deps.responseLedger.getProposedText(responseId);
  }

  /** Await the EagerEOT LLM stream (or budget) so we speak a finished reply. */
  private async waitForProvisionalComplete(responseId: string, budgetMs: number): Promise<string> {
    const stream = this.provisionalStream;
    if (stream) {
      await Promise.race([stream, this.delay(budgetMs)]);
    } else {
      await this.delay(Math.min(budgetMs, 200));
    }
    return this.deps.responseLedger.getProposedText(responseId);
  }

  private voiceCapabilities(): string[] {
    const caps = ["delegate_task"];
    if (this.deps.reminders) caps.push("update_reminder");
    if (this.deps.structuredMemory) caps.push("remember_memory");
    if (this.deps.weather) caps.push("get_weather_forecast");
    if (this.deps.lights) caps.push("control_studio_lights");
    return caps;
  }

  private async studioLightsHint(): Promise<string | undefined> {
    if (!this.deps.lights?.inventorySpeech) return undefined;
    const now = this.deps.clock.now();
    if (this.lightsHintCache && now - this.lightsHintCache.atMs < this.lightsHintTtlMs) {
      return this.lightsHintCache.text;
    }
    try {
      const hint = (await this.deps.lights.inventorySpeech()).trim();
      const text = hint || undefined;
      this.lightsHintCache = { atMs: now, text };
      return text;
    } catch (err) {
      console.warn("[voice] studio lights inventory failed:", err);
      this.lightsHintCache = { atMs: now, text: undefined };
      return undefined;
    }
  }

  private async loadDueReminders(): Promise<DueReminderSummary[]> {
    if (!this.deps.reminders) return [];
    try {
      return await this.deps.reminders.listDue();
    } catch (err) {
      console.warn("[voice] listDue reminders failed:", err);
      return [];
    }
  }

  private committedTools(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    const tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }> = [DELEGATE_TASK_TOOL];
    if (this.deps.reminders) tools.push(UPDATE_REMINDER_TOOL);
    if (this.deps.structuredMemory) tools.push(REMEMBER_MEMORY_TOOL);
    if (this.deps.weather) tools.push(GET_WEATHER_FORECAST_TOOL);
    if (this.deps.lights) tools.push(CONTROL_STUDIO_LIGHTS_TOOL);
    return tools;
  }

  private async generateCommitted(
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[],
    responseId: string,
    dueReminders: DueReminderSummary[] = [],
    opts?: { streamCaptions?: boolean },
  ): Promise<string> {
    const llmId =
      this.deps.config.pipeline.llmPriority?.orderedProviderIds[0] ?? "llm.openai.terra";
    const llm = this.deps.providers.getLlm(llmId);
    let text = "";
    let first = true;
    let toolCall: { toolName?: string; toolArgs?: Record<string, unknown> } | undefined;
    const tools = this.committedTools();
    if (opts?.streamCaptions) {
      this.lastCaptionRevealMs = 0;
      this.pendingCaptionReveal = undefined;
      await this.media.publishCaption({ type: "start", text: "" });
    }
    for await (const chunk of llm.generateStream({
      messages,
      modelPreset: "conversational",
      reasoningEffort: "none",
      tools,
    })) {
      if (chunk.type === "token" && chunk.text) {
        if (first) {
          this.mark("first_llm_token_at");
          first = false;
        }
        text += chunk.text;
        await this.deps.responseLedger.appendProposed(responseId, chunk.text);
        if (opts?.streamCaptions) {
          await this.publishCaptionReveal(text);
        }
      }
      if (chunk.type === "tool_call") {
        toolCall = { toolName: chunk.toolName, toolArgs: chunk.toolArgs };
      }
    }
    if (toolCall?.toolName === "delegate_task") {
      const category = String(toolCall.toolArgs?.category ?? "research") as TaskCategory;
      const description = String(
        toolCall.toolArgs?.taskDescription ?? toolCall.toolArgs?.description ?? "",
      );
      if (description) {
        const result = await this.deps.agents.delegate({
          correlationId: createId("corr"),
          taskDescription: description,
          taskCategory: category,
          conversationContext: messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
          permissions: ["agent.delegate"],
          requestedOutputFormat: "text",
          confirmationRequired: false,
          timeoutMs: 600_000,
        });
        const out = result.output || result.error || text;
        if (opts?.streamCaptions) await this.publishCaptionReveal(out, true);
        return out;
      }
    }
    if (toolCall?.toolName === "update_reminder" && this.deps.reminders) {
      const ack = await this.applyReminderUpdate(toolCall.toolArgs ?? {}, dueReminders);
      const spoken = text.trim();
      const out = spoken || ack;
      if (opts?.streamCaptions) await this.publishCaptionReveal(out, true);
      return out;
    }
    if (toolCall?.toolName === "remember_memory" && this.deps.structuredMemory) {
      const ack = await this.applyRememberMemory(toolCall.toolArgs ?? {});
      const spoken = text.trim();
      const out = spoken || ack;
      if (opts?.streamCaptions) await this.publishCaptionReveal(out, true);
      return out;
    }
    if (toolCall?.toolName === "get_weather_forecast" && this.deps.weather) {
      const forecast = await this.applyWeatherForecast(toolCall.toolArgs ?? {});
      if (opts?.streamCaptions) await this.publishCaptionReveal(forecast, true);
      return forecast;
    }
    if (toolCall?.toolName === "control_studio_lights" && this.deps.lights) {
      const speech = await this.applyStudioLights(toolCall.toolArgs ?? {});
      if (opts?.streamCaptions) await this.publishCaptionReveal(speech, true);
      return speech;
    }
    if (opts?.streamCaptions) await this.publishCaptionReveal(text, true);
    return text;
  }

  private async applyStudioLights(args: Record<string, unknown>): Promise<string> {
    const port = this.deps.lights;
    if (!port) return "I couldn't control the lights right now.";
    const actionRaw = String(args.action ?? "").trim().toLowerCase();
    const action = actionRaw as
      | "on"
      | "off"
      | "brighter"
      | "dimmer"
      | "warmer"
      | "cooler"
      | "set"
      | "status";
    const allowed = new Set([
      "on",
      "off",
      "brighter",
      "dimmer",
      "warmer",
      "cooler",
      "set",
      "status",
    ]);
    if (!allowed.has(action)) return "I wasn't sure what to do with the lights.";
    const target =
      typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
    const brightnessRaw = args.brightness;
    const brightness =
      typeof brightnessRaw === "number" && Number.isFinite(brightnessRaw)
        ? brightnessRaw
        : typeof brightnessRaw === "string" &&
            brightnessRaw.trim() &&
            Number.isFinite(Number(brightnessRaw))
          ? Number(brightnessRaw)
          : undefined;
    const temperature =
      typeof args.temperature === "number" || typeof args.temperature === "string"
        ? args.temperature
        : undefined;
    try {
      return await port.control({ action, target, brightness, temperature });
    } catch (err) {
      console.error("[voice] control_studio_lights failed:", err);
      return "I couldn't reach the lights just now.";
    }
  }

  private async applyWeatherForecast(args: Record<string, unknown>): Promise<string> {
    const port = this.deps.weather;
    if (!port) return "I couldn't look up the weather right now.";
    const location =
      typeof args.location === "string" && args.location.trim()
        ? args.location.trim()
        : undefined;
    const daysRaw = args.days;
    const days =
      typeof daysRaw === "number" && Number.isFinite(daysRaw)
        ? daysRaw
        : typeof daysRaw === "string" && daysRaw.trim() && Number.isFinite(Number(daysRaw))
          ? Number(daysRaw)
          : undefined;
    try {
      return await port.getForecast({ location, days });
    } catch (err) {
      console.error("[voice] get_weather_forecast failed:", err);
      return "I couldn't get the weather forecast just now.";
    }
  }

  private async applyRememberMemory(args: Record<string, unknown>): Promise<string> {
    const port = this.deps.structuredMemory;
    if (!port) return "I couldn't store that memory right now.";
    const entities = Array.isArray(args.entities)
      ? (args.entities as Array<Record<string, unknown>>)
          .map((e) => ({
            name: String(e.name ?? "").trim(),
            entityClass: typeof e.entityClass === "string" ? e.entityClass : undefined,
            summary: typeof e.summary === "string" ? e.summary : undefined,
            email: typeof e.email === "string" ? e.email.trim() : undefined,
            telephone: typeof e.telephone === "string" ? e.telephone.trim() : undefined,
            birthDate: typeof e.birthDate === "string" ? e.birthDate.trim() : undefined,
          }))
          .filter((e) => e.name)
      : [];
    const assertions = Array.isArray(args.assertions)
      ? (args.assertions as Array<Record<string, unknown>>)
          .map((a) => ({
            subjectName: String(a.subjectName ?? "").trim(),
            predicate: String(a.predicate ?? "").trim(),
            objectName: String(a.objectName ?? "").trim(),
            text: typeof a.text === "string" ? a.text : undefined,
          }))
          .filter((a) => a.subjectName && a.predicate && a.objectName)
      : [];
    const notes = Array.isArray(args.notes)
      ? (args.notes as unknown[]).map((n) => String(n).trim()).filter(Boolean)
      : [];
    if (!entities.length && !assertions.length && !notes.length) {
      return "I need something concrete to remember.";
    }
    try {
      const result = await port.remember({ entities, assertions, notes });
      const parts: string[] = [];
      if (result.entitiesUpserted) parts.push(`${result.entitiesUpserted} people or things`);
      if (result.assertionsCreated) parts.push(`${result.assertionsCreated} relationships`);
      if (result.notesCreated) parts.push(`${result.notesCreated} notes`);
      return parts.length
        ? `Got it — I've stored that in memory (${parts.join(", ")}).`
        : "Got it — I've noted that.";
    } catch (err) {
      console.error("[voice] remember_memory failed:", err);
      return "I couldn't store that memory just now.";
    }
  }

  private async applyReminderUpdate(
    args: Record<string, unknown>,
    dueReminders: DueReminderSummary[],
  ): Promise<string> {
    const reminders = this.deps.reminders;
    if (!reminders) return "I couldn't update that reminder right now.";

    const actionRaw = String(args.action ?? "")
      .trim()
      .toLowerCase();
    if (actionRaw !== "completed" && actionRaw !== "dismissed" && actionRaw !== "snoozed") {
      return "I need to know whether to complete, dismiss, or snooze that reminder.";
    }

    const due = dueReminders.length > 0 ? dueReminders : await this.loadDueReminders();
    const resolved = resolveReminderMatch(due, {
      recordId: typeof args.recordId === "string" ? args.recordId : null,
      match: typeof args.match === "string" ? args.match : null,
    });

    if (resolved.kind === "none") {
      return "I don't see a matching due reminder to update.";
    }
    if (resolved.kind === "ambiguous") {
      const names = resolved.candidates
        .slice(0, 4)
        .map((c) => c.summary)
        .join("; ");
      return `Which reminder should I update — ${names}?`;
    }

    const target = resolved.reminder;
    const snoozedUntil =
      typeof args.snoozedUntil === "string" ? args.snoozedUntil.trim() : undefined;
    if (actionRaw === "snoozed" && !snoozedUntil) {
      return "When should I remind you again?";
    }

    try {
      await reminders.setStatus(target.recordId, actionRaw, snoozedUntil);
      await reminders.invalidateBriefingDay();
      if (actionRaw === "completed") {
        return `Got it — I've cleared the reminder about ${target.summary}.`;
      }
      if (actionRaw === "dismissed") {
        return `Okay — I won't keep reminding you about ${target.summary}.`;
      }
      return `Okay — I'll snooze the reminder about ${target.summary} until ${snoozedUntil}.`;
    } catch (err) {
      console.error("[voice] update_reminder failed:", err);
      return "I couldn't update that reminder just now.";
    }
  }

  private async finishTurn(opts?: { speak?: boolean }): Promise<void> {
    this.turnInFlight = false;
    // Never leave Shhh residue for the following utterance.
    this.suppressSpeak = false;
    const pending = this.pendingUserText;
    this.pendingUserText = undefined;
    if (pending) {
      const source = this.pendingUserSource ?? "stt.end_of_turn";
      this.pendingUserSpeak = undefined;
      this.pendingUserSource = undefined;
      this.bargeInListening = false;
      this.bargeInDraft = undefined;
      if (source === "text") {
        this.turnInFlight = true;
        this.lastUserTurn = pending;
        void this.runCommittedTurn(pending, { source: "text", speak: false }).catch((err) => {
          console.error("[voice] runCommittedTurn (text drain) failed:", err);
        });
        return;
      }
      await this.publishUserTranscriptUi(pending, "final");
      await this.commitEndOfTurn(pending, { force: true });
      return;
    }
    this.pendingUserSpeak = undefined;
    this.pendingUserSource = undefined;
    if (this.bargeInListening) {
      console.log("[voice] barge-in listening for complete ask");
      return;
    }
    if (opts?.speak !== false) this.armEchoGuard();
  }

  private async deliverAssistant(
    responseId: string,
    text: string,
    speak: boolean,
    opts?: { alreadyStreaming?: boolean },
  ): Promise<void> {
    if (speak) {
      await this.speakWithMultiContext(responseId, text, "primary");
      return;
    }
    await this.deliverTextCaption(responseId, text, opts);
  }

  private async deliverTextCaption(
    responseId: string,
    text: string,
    opts?: { alreadyStreaming?: boolean },
  ): Promise<void> {
    if (!text.trim()) return;
    await this.deps.responseLedger.addSegment(responseId, "primary", text);
    await this.deps.responseLedger.markDelivered(responseId, text);
    if (!opts?.alreadyStreaming) {
      await this.media.publishCaption({ type: "start", text });
    }
    await this.publishCaptionReveal(text, true);
    await this.media.publishCaption({ type: "end", reason: "complete" });
    if (this.deps.fsm.canTransition("Listening")) {
      await this.deps.fsm.transition("Listening", "voice.text_turn_complete");
    } else {
      await this.deps.fsm.force("Listening", "voice.text_turn_complete");
    }
  }

  private async publishCaptionReveal(text: string, force = false): Promise<void> {
    const now = this.deps.clock.now();
    if (!force && now - this.lastCaptionRevealMs < 50) {
      this.pendingCaptionReveal = text;
      return;
    }
    this.lastCaptionRevealMs = now;
    this.pendingCaptionReveal = undefined;
    await this.media.publishCaption({ type: "reveal", text });
  }

  private async speakWithMultiContext(
    responseId: string,
    text: string,
    kind: "primary" | "addendum" | "replacement" | "resumption",
  ): Promise<void> {
    if (!this.ttsSession || !text.trim()) return;

    // Captions keep markdown for the HUD; TTS gets a sync plain-text strip so
    // markers never reach the synthesizer (and never delay first audio).
    const displayText = text;
    const speechText = stripMarkdownForSpeech(text);
    if (!speechText.trim()) {
      await this.deliverTextCaption(responseId, displayText);
      return;
    }

    const contextId = `${kind}_${createId("ctx")}`;
    this.activeContextId = contextId;
    const segment = await this.deps.responseLedger.addSegment(responseId, kind, displayText);
    await this.ttsSession.openContext(contextId, segment.id);
    await this.deps.responseLedger.submitToTts(responseId, speechText);

    if (this.deps.fsm.canTransition("SynthesizingSpeech")) {
      await this.deps.fsm.transition("SynthesizingSpeech", "tts.multi_context");
    } else {
      await this.deps.fsm.force("SynthesizingSpeech", "tts.multi_context");
    }
    if (this.deps.fsm.canTransition("AssistantSpeaking")) {
      await this.deps.fsm.transition("AssistantSpeaking", "tts.play");
    } else {
      await this.deps.fsm.force("AssistantSpeaking", "tts.play");
    }

    await this.media.resumePlayback();
    this.speakAbort?.abort();
    this.speakAbort = new AbortController();
    const signal = this.speakAbort.signal;

    this.isSpeaking = true;
    this.lastAssistantSpeech = speechText;
    this.partialText = "";
    this.selfVoice.clear();
    this.selfVoice.arm();
    await this.media.publishCaption({ type: "start", text: displayText });

    // One flush for the full reply — sentence chunking caused mid-answer skips when
    // the next flush started before ElevenLabs finished the previous audio.
    let firstSpeakable = true;
    let firstTts = true;
    let firstBuffered = true;
    let firstPlayed = true;
    let charCursor = 0;
    let bargedIn = false;
    let lastReveal = "";

    this.mark("first_speakable_chunk_at");
    for await (const ev of this.ttsSession.synthesizeToContext(contextId, speechText, {
      flush: true,
      signal,
    })) {
      if (signal.aborted || this.activeContextId !== contextId || !this.isSpeaking) {
        bargedIn = true;
        break;
      }
      if (ev.type === "audio-buffered") {
        if (firstTts) {
          this.mark("first_tts_byte_at");
          firstTts = false;
        }
        if (firstBuffered) {
          this.mark("first_audio_buffered_at");
          firstBuffered = false;
        }
        if (firstSpeakable) firstSpeakable = false;
        await this.deps.responseLedger.bufferAudio(responseId, speechText);
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "tts.audio_buffered",
          responseId,
          payload: { ...ev },
        });
        if (ev.pcm) {
          // Stop may land between events — never queue another frame after abort.
          if (signal.aborted || !this.isSpeaking || this.activeContextId !== contextId) {
            bargedIn = true;
            break;
          }
          const pcmFrame = {
            data: ev.pcm,
            sampleRate: ev.sampleRate ?? 24_000,
            channels: 1 as const,
          };
          this.selfVoice.pushReference(pcmFrame);
          await this.media.playPcm(pcmFrame);
          // Drop anything still in-flight after a barge-in stop.
          if (signal.aborted || !this.isSpeaking) {
            bargedIn = true;
            break;
          }
          if (firstPlayed) {
            this.mark("first_audio_played_at");
            firstPlayed = false;
          }
        }
      } else if (ev.type === "word-aligned") {
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "tts.word_aligned",
          responseId,
          payload: { ...ev },
        });
        const slice = speechText.slice(ev.characterStart, ev.characterEnd);
        if (slice) {
          await this.deps.responseLedger.markDelivered(responseId, slice);
          charCursor = Math.max(charCursor, ev.characterEnd);
          const revealed = revealMarkdownBySpeechProgress(displayText, speechText, charCursor);
          if (revealed !== lastReveal) {
            lastReveal = revealed;
            await this.media.publishCaption({ type: "reveal", text: revealed });
          }
        }
      } else if (ev.type === "playback-confirmed") {
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "tts.playback_confirmed",
          responseId,
          payload: { ...ev },
        });
        if (ev.deliveredText) {
          const already = this.deps.responseLedger.getDeliveredText(responseId);
          if (!already && ev.deliveredText) {
            await this.deps.responseLedger.markDelivered(responseId, ev.deliveredText);
          }
        }
      }
    }

    if (bargedIn || signal.aborted) {
      this.isSpeaking = false;
      await this.media.publishCaption({ type: "end", reason: "interrupted" });
      return;
    }

    // If no alignment events, mark full text delivered after playback.
    if (!this.deps.responseLedger.getDeliveredText(responseId)) {
      await this.deps.responseLedger.markDelivered(responseId, speechText);
    }
    if (lastReveal !== displayText) {
      await this.media.publishCaption({ type: "reveal", text: displayText });
    }

    await this.ttsSession.closeContext(contextId, "complete");
    this.isSpeaking = false;
    this.activeContextId = undefined;
    this.armEchoGuard();
    this.partialText = "";
    await this.media.publishCaption({ type: "end", reason: "complete" });
    if (this.deps.fsm.canTransition("Listening")) {
      await this.deps.fsm.transition("Listening", "voice.turn_complete");
    } else {
      await this.deps.fsm.force("Listening", "voice.turn_complete");
    }
  }

  private pushRecentTurn(role: "user" | "assistant", text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.recentTurns.push({ role, text: trimmed });
    if (this.recentTurns.length > this.maxRecentTurns) {
      this.recentTurns.splice(0, this.recentTurns.length - this.maxRecentTurns);
    }
  }

  /**
   * Prior turns for the prompt assembler.
   * When the current user utterance is already in recentTurns, omit it — it is
   * also passed as `currentUserTurn`.
   */
  private recentConversationForPrompt(): { role: "user" | "assistant"; text: string }[] {
    if (this.recentTurns.length === 0) return [];
    const last = this.recentTurns[this.recentTurns.length - 1];
    const prior = last?.role === "user" ? this.recentTurns.slice(0, -1) : this.recentTurns;
    return prior.map((t) => ({ role: t.role, text: t.text }));
  }

  private async mark(name: LatencyMarkName): Promise<void> {
    if (this.latencyMarks.has(name)) return;
    const at = this.deps.clock.now();
    this.latencyMarks.set(name, at);
    await this.deps.events.emit({
      sessionId: this.deps.sessionId,
      type: "latency.mark",
      payload: { name, atMs: at, iso: this.deps.clock.nowIso() },
    });
  }
}

/** True when a reused EagerEOT draft looks cut off mid-thought. */
export function looksTruncatedAssistantReply(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length < 8) return true;
  // Finished sentence / question / ellipsis.
  if (/[.!?…]["')\]]*\s*$/.test(t)) return false;
  // Em-dash / hyphen cutoffs are the classic truncated stream symptom.
  if (/[—–-]\s*$/.test(t)) return true;
  // Hanging function word / article ("Exactly—the last quiet" without period is
  // caught above only if punctuated; also catch "Do you mean").
  if (/\b(the|a|an|and|or|to|of|in|on|for|with|exactly|mean|about)\s*$/i.test(t)) {
    return true;
  }
  // No terminal punctuation and short → almost certainly incomplete for voice.
  if (t.length < 48) return true;
  return false;
}

/** Stopwords ignored when judging whether busy-turn speech is a real follow-up. */
const NOVEL_TURN_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "am",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "my",
  "your",
  "me",
  "with",
  "that",
  "this",
  "just",
  "so",
  "but",
  "not",
  "no",
  "yes",
  "ok",
  "okay",
  "uh",
  "um",
  "hey",
  "hi",
  "oh",
]);
