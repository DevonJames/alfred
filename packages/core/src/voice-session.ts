import {
  createId,
  DELEGATE_TASK_TOOL,
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
import type { MediaPort } from "./media-port.js";
import { NullMediaPort } from "./media-port.js";
import type { AgentRouterPort, MemoryControllerPort, ProviderRegistryPort } from "./ports.js";
import { PromptAssembler } from "./prompt-assembler.js";
import type { ResponseLedger } from "./response-ledger.js";
import type { ConversationStateMachine } from "./state-machine.js";
import {
  extractBargeInText,
  hasInterruptCue,
  isConfidentBargeIn,
  isEchoTranscript,
  looksIncompleteInterrupt,
} from "./echo-filter.js";
import { SelfVoiceGate } from "./self-voice.js";
import { looksLikeXIngestTask } from "./x-ingest-intent.js";

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

  private partialText = "";
  private provisionalResponseId?: string;
  private provisionalAbort?: AbortController;
  private activeContextId?: string;
  private activeResponseId?: string;
  private isSpeaking = false;
  /** True while a committed turn is generating/speaking — serialize turns. */
  private turnInFlight = false;
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

    this.sttSession = this.deps.sttSessionFactory
      ? await this.deps.sttSessionFactory()
      : await this.openSttFromRegistry();

    this.ttsSession = this.deps.ttsSessionFactory
      ? await this.deps.ttsSessionFactory()
      : await this.openTtsFromRegistry();

    this.unsubAudio = this.media.onAudioFrame((frame) => {
      void this.onAudioFrame(frame);
    });
    this.unsubVad = this.media.onVad((signal) => {
      void this.onVad(signal);
    });

    void this.consumeSttEvents();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.unsubAudio?.();
    this.unsubVad?.();
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

  getLatencyMarks(): ReadonlyMap<LatencyMarkName, number> {
    return this.latencyMarks;
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

  /** Strip leading assistant-echo glued onto an interrupt before committing it. */
  private cleanBargeInText(text: string): string {
    return extractBargeInText(this.echoInput(text));
  }

  private async onAudioFrame(frame: AudioFrame): Promise<void> {
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
  private async publishUserTranscriptUi(
    text: string,
    kind: "partial" | "final",
  ): Promise<void> {
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
    if (!this.isRealBargeIn(text)) return;
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
    const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
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
    if (!this.sttSession) return;
    for await (const event of this.sttSession.events()) {
      if (!this.running) break;
      await this.onSttEvent(event);
    }
  }

  private async onSttEvent(event: SttTurnEvent): Promise<void> {
    if (process.env.ALFRED_LOG_VOICE === "1" || process.env.ALFRED_LOG_STT === "1") {
      console.log(`[voice] stt ${event.type}${event.text ? `: ${event.text.slice(0, 100)}` : ""}`);
    }

    const eventText =
      event.type === "partial_transcript" ||
      event.type === "start_of_turn" ||
      event.type === "eager_end_of_turn" ||
      event.type === "turn_resumed" ||
      event.type === "end_of_turn"
        ? (event.text ?? this.partialText)
        : undefined;

    // Barge-in BEFORE echo-ignore — STT often glues echo + interrupt into one string.
    if (
      (this.isSpeaking || this.turnInFlight) &&
      (event.type === "eager_end_of_turn" ||
        event.type === "end_of_turn" ||
        event.type === "turn_resumed" ||
        event.type === "partial_transcript") &&
      this.isRealBargeIn(eventText)
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
        console.log(
          `[voice] ignoring echo stt ${event.type}: "${(eventText ?? "").slice(0, 80)}"`,
        );
      }
      return;
    }

    if (
      this.isSpeaking &&
      (event.type === "eager_end_of_turn" ||
        event.type === "end_of_turn" ||
        event.type === "turn_resumed")
    ) {
      // Weak / echo-like while speaking — ignore.
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
          if (this.isRealBargeIn(this.partialText)) {
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
        await this.beginProvisionalGeneration(this.partialText);
        break;

      case "turn_resumed":
        this.partialText = event.text ?? this.partialText;
        if (this.turnInFlight) {
          if (this.isRealBargeIn(this.partialText)) {
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

  private async beginProvisionalGeneration(text: string): Promise<void> {
    if (!text.trim()) return;
    // Do not commit user turn yet — provisional segment only.
    this.provisionalAbort?.abort({ reason: "superseded_generation" });
    this.provisionalAbort = new AbortController();
    const responseId = this.deps.responseLedger.beginResponse(
      this.deps.sessionId,
      createId("turn_prov"),
    );
    this.provisionalResponseId = responseId;

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

    const memory = await this.deps.memory.retrieve({
      text,
      profileId: this.deps.profileId,
      sessionId: this.deps.sessionId,
      limit: 8,
    });

    const prompt = this.promptAssembler.assemble({
      systemInstructions: this.deps.config.systemInstructions,
      currentUserTurn: text,
      recentConversation: [],
      personaContext: this.deps.personaContext,
      retrievedMemory: memory.items,
      mode: "initial",
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: ["delegate_task"],
      existingResponseState: {
        spokenText: "",
        unspokenText: "",
        proposedText: "",
        isGenerating: true,
        isSpeaking: false,
      },
    });

    void this.streamProvisionalLlm(prompt.messages, responseId, this.provisionalAbort.signal);
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
    // While a turn is actively generating/speaking: queue real barge-ins, drop echo.
    if (!opts?.force && (this.turnInFlight || this.isSpeaking)) {
      if (!this.isRealBargeIn(text) && !this.bargeInListening) {
        if (process.env.ALFRED_LOG_VOICE === "1") {
          console.log(`[voice] skip commit (echo/weak): "${text.slice(0, 100)}"`);
        }
        return;
      }
      if (this.isRealBargeIn(text) || this.bargeInListening) {
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

    // Idle but still in post-TTS echo cooldown: ignore echo, allow novel speech through.
    if (!opts?.force && this.inEchoWindow() && !this.isRealBargeIn(text)) {
      if (process.env.ALFRED_LOG_VOICE === "1") {
        console.log(`[voice] skip commit (echo cooldown): "${text.slice(0, 100)}"`);
      }
      return;
    }

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

  private async runCommittedTurn(text: string): Promise<void> {
    const turnId = createId("turn");
    await this.deps.events.emit({
      sessionId: this.deps.sessionId,
      type: "turn.committed",
      turnId,
      payload: { text, source: "stt.end_of_turn" },
    });

    await this.deps.memory.commitTurn({
      profileId: this.deps.profileId,
      sessionId: this.deps.sessionId,
      turnId,
      role: "user",
      text,
      metadata: {},
    });

    // Daily briefing: play / decline may short-circuit the normal LLM path.
    let briefingDecision: BriefingVoiceDecision | undefined;
    if (this.deps.briefing) {
      try {
        briefingDecision = await this.deps.briefing.handleUserTurn(text);
      } catch (err) {
        console.error("[voice] briefing handleUserTurn failed:", err);
      }
    }

    if (briefingDecision?.action === "play" || briefingDecision?.action === "decline") {
      try {
        this.provisionalAbort?.abort({ reason: "briefing_short_circuit" });
        const responseId = this.deps.responseLedger.beginResponse(this.deps.sessionId, turnId);
        this.provisionalResponseId = responseId;
        const assistantText = briefingDecision.speech;
        if (this.pendingUserText || this.bargeInListening) {
          console.log("[voice] skip briefing speak; barge-in pending");
          return;
        }
        await this.deps.responseLedger.commit(responseId, assistantText);
        this.activeResponseId = responseId;
        console.log(`[voice] speaking briefing: "${assistantText.slice(0, 160)}"`);
        await this.speakWithMultiContext(responseId, assistantText, "primary");
        await this.deps.memory.commitTurn({
          profileId: this.deps.profileId,
          sessionId: this.deps.sessionId,
          turnId: createId("turn"),
          role: "assistant",
          text: assistantText,
          metadata: { responseId, briefing: briefingDecision.action },
        });
        console.log("[voice] briefing turn playback complete");
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
        this.turnInFlight = false;
        const pending = this.pendingUserText;
        this.pendingUserText = undefined;
        if (pending) {
          this.bargeInListening = false;
          this.bargeInDraft = undefined;
          await this.publishUserTranscriptUi(pending, "final");
          this.commitEndOfTurn(pending);
        }
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
        if (this.pendingUserText || this.bargeInListening) {
          console.log("[voice] skip X ingest speak; barge-in pending");
          return;
        }
        await this.deps.responseLedger.commit(responseId, assistantText);
        this.activeResponseId = responseId;
        await this.speakWithMultiContext(responseId, assistantText, "primary");
        await this.deps.memory.commitTurn({
          profileId: this.deps.profileId,
          sessionId: this.deps.sessionId,
          turnId: createId("turn"),
          role: "assistant",
          text: assistantText,
          metadata: { responseId, xIngest: true },
        });
      } catch (err) {
        console.error("[voice] X ingest failed:", err);
      } finally {
        this.turnInFlight = false;
        const pending = this.pendingUserText;
        this.pendingUserText = undefined;
        if (pending) {
          this.bargeInListening = false;
          this.bargeInDraft = undefined;
          await this.publishUserTranscriptUi(pending, "final");
          this.commitEndOfTurn(pending);
        }
      }
      return;
    }

    const memory = await this.deps.memory.retrieve({
      text,
      profileId: this.deps.profileId,
      sessionId: this.deps.sessionId,
      limit: 8,
    });
    const hasDurableMemory = memory.items.some((m) => {
      const kind = m.provenance?.kind;
      return kind === "fact" || kind === "note";
    });

    const appendOffer = briefingDecision?.action === "chat" && briefingDecision.appendOffer;
    const offerHint =
      briefingDecision?.action === "chat" ? briefingDecision.systemHint : undefined;

    try {
      let responseId = this.provisionalResponseId;
      let assistantText = responseId ? this.deps.responseLedger.getProposedText(responseId) : "";

      // Soft-offer turns always regenerate so the system hint applies (skip provisional).
      // Always regenerate when durable memory is available — provisional EagerEOT
      // often raced before facts were relevant, or reused a no-memory draft.
      if (!responseId || !assistantText.trim() || hasDurableMemory || appendOffer) {
        this.provisionalAbort?.abort({ reason: "superseded_generation" });
        responseId = this.deps.responseLedger.beginResponse(this.deps.sessionId, turnId);
        this.provisionalResponseId = responseId;
        if (hasDurableMemory && process.env.ALFRED_LOG_VOICE === "1") {
          console.log(
            `[voice] regenerating with ${memory.items.length} memory item(s) (durable facts/notes)`,
          );
        }
        const systemInstructions = offerHint
          ? `${this.deps.config.systemInstructions}\n\n${offerHint}`
          : this.deps.config.systemInstructions;
        const prompt = this.promptAssembler.assemble({
          systemInstructions,
          currentUserTurn: text,
          recentConversation: [],
          personaContext: this.deps.personaContext,
          retrievedMemory: memory.items,
          mode: "initial",
          lateAddenda: [],
          agentResults: [],
          availableCapabilities: ["delegate_task"],
        });
        assistantText = await this.generateCommitted(prompt.messages, responseId);
      }

      if (appendOffer && this.deps.briefing) {
        const closer = this.deps.briefing.offerCloser;
        if (!assistantText.includes(closer)) {
          assistantText = `${assistantText.trim()} ${closer}`.trim();
        }
      }

      // Barge-in arrived while we were generating — skip speaking this reply.
      if (this.pendingUserText || this.bargeInListening) {
        console.log(
          this.pendingUserText
            ? "[voice] skip speak; pending barge-in"
            : "[voice] skip speak; waiting for complete interrupt",
        );
        return;
      }

      await this.deps.responseLedger.commit(responseId, assistantText);
      this.activeResponseId = responseId;
      console.log(`[voice] speaking: "${assistantText.slice(0, 160)}"`);
      await this.speakWithMultiContext(responseId, assistantText, "primary");
      await this.deps.memory.commitTurn({
        profileId: this.deps.profileId,
        sessionId: this.deps.sessionId,
        turnId: createId("turn"),
        role: "assistant",
        text: assistantText,
        metadata: { responseId },
      });
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
      this.turnInFlight = false;
      const pending = this.pendingUserText;
      this.pendingUserText = undefined;
      if (pending) {
        this.bargeInListening = false;
        this.bargeInDraft = undefined;
        await this.publishUserTranscriptUi(pending, "final");
        // Force-start the interrupting turn (do not re-queue as barge-in).
        await this.commitEndOfTurn(pending, { force: true });
      } else if (this.bargeInListening) {
        // Audio already cut; wait for end_of_turn with the full ask.
        console.log("[voice] barge-in listening for complete ask");
      } else {
        this.armEchoGuard();
      }
    }
  }

  private async generateCommitted(
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[],
    responseId: string,
  ): Promise<string> {
    const llmId =
      this.deps.config.pipeline.llmPriority?.orderedProviderIds[0] ?? "llm.openai.terra";
    const llm = this.deps.providers.getLlm(llmId);
    let text = "";
    let first = true;
    let toolCall: { toolName?: string; toolArgs?: Record<string, unknown> } | undefined;
    for await (const chunk of llm.generateStream({
      messages,
      modelPreset: "conversational",
      reasoningEffort: "none",
      tools: [DELEGATE_TASK_TOOL],
    })) {
      if (chunk.type === "token" && chunk.text) {
        if (first) {
          this.mark("first_llm_token_at");
          first = false;
        }
        text += chunk.text;
        await this.deps.responseLedger.appendProposed(responseId, chunk.text);
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
        return result.output || result.error || text;
      }
    }
    return text;
  }

  private async speakWithMultiContext(
    responseId: string,
    text: string,
    kind: "primary" | "addendum" | "replacement" | "resumption",
  ): Promise<void> {
    if (!this.ttsSession || !text.trim()) return;

    const contextId = `${kind}_${createId("ctx")}`;
    this.activeContextId = contextId;
    const segment = await this.deps.responseLedger.addSegment(responseId, kind, text);
    await this.ttsSession.openContext(contextId, segment.id);
    await this.deps.responseLedger.submitToTts(responseId, text);

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
    this.lastAssistantSpeech = text;
    this.partialText = "";
    this.selfVoice.clear();
    this.selfVoice.arm();
    await this.media.publishCaption({ type: "start", text });

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
    for await (const ev of this.ttsSession.synthesizeToContext(contextId, text, {
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
        await this.deps.responseLedger.bufferAudio(responseId, text);
        await this.deps.events.emit({
          sessionId: this.deps.sessionId,
          type: "tts.audio_buffered",
          responseId,
          payload: { ...ev },
        });
        if (ev.pcm) {
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
        const slice = text.slice(ev.characterStart, ev.characterEnd);
        if (slice) {
          await this.deps.responseLedger.markDelivered(responseId, slice);
          charCursor = Math.max(charCursor, ev.characterEnd);
          const revealed = text.slice(0, charCursor);
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
      await this.deps.responseLedger.markDelivered(responseId, text);
    }
    if (lastReveal !== text) {
      await this.media.publishCaption({ type: "reveal", text });
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
