import {
  createId,
  type ArbitrationOutcome,
  type CancellationReason,
  type ConversationTurn,
  type PersonaContext,
  type PipelineConfiguration,
  type ProviderFailureClass,
  type ProviderPriorityList,
  type SttResult,
  type TaskCategory,
  type UserConfiguration,
} from "@alfred/contracts";
import type { PersistenceBundle } from "@alfred/persistence";
import type { Clock } from "./clock.js";
import { EventLedger } from "./event-ledger.js";
import { StickyFailoverController } from "./failover.js";
import {
  firstSentence,
  type BackchannelClassifier,
  type InterruptionArbiter,
  HeuristicBackchannelClassifier,
  RuleBasedInterruptionArbiter,
} from "./interruption.js";
import { NoopObservability, type Observability } from "./observability.js";
import { getSelectorLocks, validatePipelineConfiguration } from "./pipeline.js";
import type { AgentRouterPort, MemoryControllerPort, ProviderRegistryPort } from "./ports.js";
import { PromptAssembler } from "./prompt-assembler.js";
import { ResponseLedger } from "./response-ledger.js";
import { ConversationStateMachine } from "./state-machine.js";
import { looksLikeDocsIngestTask } from "./docs-ingest-intent.js";
import { looksLikeXIngestTask } from "./x-ingest-intent.js";

export interface SpeechDeliveryOptions {
  /** Milliseconds per simulated speech chunk. */
  chunkDurationMs: number;
  /** Approximate characters per chunk. */
  charsPerChunk: number;
}

export interface SessionOrchestratorOptions {
  sessionId?: string;
  profileId: string;
  config: UserConfiguration;
  persistence: PersistenceBundle;
  providers: ProviderRegistryPort;
  memory: MemoryControllerPort;
  agents: AgentRouterPort;
  clock: Clock;
  /** Always-on SOUL / IDENTITY / USER bootstrap (OpenClaw-style). */
  personaContext?: PersonaContext;
  observability?: Observability;
  backchannelClassifier?: BackchannelClassifier;
  interruptionArbiter?: InterruptionArbiter;
  speech?: SpeechDeliveryOptions;
}

export interface UserUtteranceInput {
  text: string;
  audioRef?: string;
  utteranceKind?: SttResult["utteranceKind"];
  /** While assistant is speaking: force arbitration outcome. */
  forcedArbitration?: ArbitrationOutcome;
  /** Treat as late addendum if generation is in progress. */
  asAddendum?: boolean;
  /** Host-provided system extras (calendar, FACE/SPEECH, agent persona). */
  extraSystem?: string;
  /** Camera frames or other images for this turn. */
  imageDataUrls?: string[];
  /** Stream token deltas to an HTTP host as they arrive. */
  onToken?: (delta: string) => void;
}

export interface SessionSnapshot {
  sessionId: string;
  state: string;
  pipelineMode: PipelineConfiguration["mode"];
  activeLlmProviderId?: string;
  activeSttProviderId?: string;
  activeTtsProviderId?: string;
  activeUnifiedProviderId?: string;
  currentResponseId?: string;
  recentTurns: ConversationTurn[];
  selectorLocks: ReturnType<typeof getSelectorLocks>;
}

/**
 * Owns the conversational session. Text-only M1 path uses timed chunk delivery.
 */
export class SessionOrchestrator {
  readonly sessionId: string;
  private readonly fsm: ConversationStateMachine;
  private readonly events: EventLedger;
  private readonly responseLedger: ResponseLedger;
  private readonly promptAssembler = new PromptAssembler();
  private readonly backchannelClassifier: BackchannelClassifier;
  private readonly interruptionArbiter: InterruptionArbiter;
  private readonly speech: SpeechDeliveryOptions;
  private readonly observability: Observability;

  private config: UserConfiguration;
  private llmFailover?: StickyFailoverController;
  private sttFailover?: StickyFailoverController;
  private ttsFailover?: StickyFailoverController;
  private unifiedFailover?: StickyFailoverController;

  private recentTurns: ConversationTurn[] = [];
  private currentTurnId?: string;
  private currentResponseId?: string;
  private generationAbort?: AbortController;
  private deliveryAbort?: AbortController;
  private isGenerating = false;
  private isSpeaking = false;
  private pendingAddenda: string[] = [];
  private lastDeliveredCommitted = "";
  private interruptedDuringDelivery = false;
  private turnExtraSystem?: string;
  private turnImageDataUrls?: string[];
  private turnOnToken?: (delta: string) => void;

  constructor(private readonly opts: SessionOrchestratorOptions) {
    this.sessionId = opts.sessionId ?? createId("sess");
    this.config = opts.config;
    this.observability = opts.observability ?? new NoopObservability();
    this.events = new EventLedger(opts.persistence.events, opts.clock, this.observability);
    this.fsm = new ConversationStateMachine(this.sessionId, this.events);
    this.responseLedger = new ResponseLedger(
      opts.persistence.responseLedgers,
      this.events,
      opts.clock,
    );
    this.backchannelClassifier = opts.backchannelClassifier ?? new HeuristicBackchannelClassifier();
    this.interruptionArbiter = opts.interruptionArbiter ?? new RuleBasedInterruptionArbiter();
    this.speech = opts.speech ?? { chunkDurationMs: 50, charsPerChunk: 20 };
  }

  async start(): Promise<void> {
    const manifests = this.opts.providers.listManifests();
    const validation = validatePipelineConfiguration(this.config.pipeline, manifests);
    if (!validation.valid) {
      throw new Error(`Invalid pipeline configuration: ${validation.errors.join("; ")}`);
    }

    await this.opts.persistence.sessions.create({
      id: this.sessionId,
      profileId: this.opts.profileId,
      createdAt: this.opts.clock.nowIso(),
      pipelineMode: this.config.pipeline.mode,
    });
    await this.opts.persistence.userConfigurations.save(this.config);
    await this.events.emit({
      sessionId: this.sessionId,
      type: "session.started",
      payload: { profileId: this.opts.profileId, mode: this.config.pipeline.mode },
    });
    await this.events.emit({
      sessionId: this.sessionId,
      type: "pipeline.configured",
      payload: { mode: this.config.pipeline.mode, locks: validation.locks },
    });

    this.initFailovers();
    if (this.config.pipeline.mode === "unified") {
      await this.unifiedFailover?.selectInitial();
    } else {
      await this.sttFailover?.selectInitial();
      await this.llmFailover?.selectInitial();
      await this.ttsFailover?.selectInitial();
    }

    await this.fsm.transition("Listening", "session.start");
  }

  getState() {
    return this.fsm.getState();
  }

  getEvents() {
    return this.events.list(this.sessionId);
  }

  getResponseLedger() {
    return this.responseLedger;
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.fsm.getState(),
      pipelineMode: this.config.pipeline.mode,
      activeLlmProviderId: this.llmFailover?.getActiveProviderId(),
      activeSttProviderId: this.sttFailover?.getActiveProviderId(),
      activeTtsProviderId: this.ttsFailover?.getActiveProviderId(),
      activeUnifiedProviderId: this.unifiedFailover?.getActiveProviderId(),
      currentResponseId: this.currentResponseId,
      recentTurns: [...this.recentTurns],
      selectorLocks: getSelectorLocks(this.config.pipeline, this.opts.providers.listManifests()),
    };
  }

  async updatePipeline(pipeline: PipelineConfiguration): Promise<void> {
    const manifests = this.opts.providers.listManifests();
    const validation = validatePipelineConfiguration(pipeline, manifests);
    if (!validation.valid) {
      throw new Error(`Invalid pipeline configuration: ${validation.errors.join("; ")}`);
    }
    this.config = { ...this.config, pipeline };
    await this.opts.persistence.userConfigurations.save(this.config);
    this.initFailovers();
    if (pipeline.mode === "unified") {
      await this.unifiedFailover?.selectInitial();
    } else {
      await this.sttFailover?.selectInitial();
      await this.llmFailover?.selectInitial();
      await this.ttsFailover?.selectInitial();
    }
    await this.events.emit({
      sessionId: this.sessionId,
      type: "pipeline.configured",
      payload: { mode: pipeline.mode, locks: validation.locks },
    });
  }

  async checkPrimaryLlm(): Promise<boolean> {
    return (await this.llmFailover?.checkPrimary()) ?? false;
  }

  async maybeRestorePrimaryLlm(): Promise<boolean> {
    return (await this.llmFailover?.maybeRestorePrimary()) ?? false;
  }

  async setActiveMemoryProvider(providerId: string): Promise<void> {
    await this.opts.memory.setActiveProviderId(providerId);
    this.config = {
      ...this.config,
      profile: {
        ...this.config.profile,
        activeMemoryProviderId: providerId,
        updatedAt: this.opts.clock.nowIso(),
      },
    };
    await this.opts.persistence.userConfigurations.save(this.config);
    await this.events.emit({
      sessionId: this.sessionId,
      type: "memory.written",
      payload: { action: "active_provider_changed", providerId },
    });
  }

  /**
   * Primary entry: user utterance in text-only simulator.
   * Routes to addendum / backchannel / interruption / normal turn based on state.
   */
  async handleUserUtterance(input: UserUtteranceInput): Promise<void> {
    this.turnExtraSystem = input.extraSystem;
    this.turnImageDataUrls = input.imageDataUrls;
    this.turnOnToken = input.onToken;
    const state = this.fsm.getState();

    if (this.isSpeaking || state === "AssistantSpeaking") {
      await this.handleSpeechOverlap(input);
      return;
    }

    if (
      this.isGenerating ||
      state === "GeneratingResponse" ||
      state === "UserAddendumReceived" ||
      input.asAddendum
    ) {
      await this.handleAddendum(input.text);
      return;
    }

    await this.handleNormalTurn(input);
  }

  async cancel(reason: CancellationReason = "user_cancellation"): Promise<void> {
    this.generationAbort?.abort({ reason });
    this.deliveryAbort?.abort({ reason });
    this.isGenerating = false;
    this.isSpeaking = false;
    if (this.currentResponseId) {
      const unspoken = this.responseLedger.getUnspokenRemainder(this.currentResponseId);
      if (unspoken) {
        await this.responseLedger.abandon(this.currentResponseId, unspoken, reason);
      }
    }
    await this.events.emit({
      sessionId: this.sessionId,
      type: "cancellation",
      turnId: this.currentTurnId,
      responseId: this.currentResponseId,
      payload: { reason },
    });
    if (this.fsm.canTransition("Cancelled")) {
      await this.fsm.transition("Cancelled", "cancel");
    } else {
      await this.fsm.force("Cancelled", "cancel");
    }
  }

  private async handleNormalTurn(input: UserUtteranceInput): Promise<void> {
    const span = this.observability.startSpan("turn.normal");
    try {
      if (this.fsm.getState() === "Idle" || this.fsm.getState() === "Cancelled") {
        await this.fsm.force("Listening", "prepare_turn");
      }
      await this.fsm.transition("UserSpeechDetected", "user.speech");
      await this.fsm.transition("Transcribing", "stt.start");

      const sttResult = await this.transcribe(input);
      const text = sttResult.text || input.text;
      const turn = await this.commitUserTurn(text);

      await this.fsm.transition("UserTurnCommitted", "turn.committed", { turnId: turn.id });
      await this.fsm.transition("RetrievingMemory", "memory.retrieve", { turnId: turn.id });

      const memory = await this.opts.memory.retrieve({
        text,
        profileId: this.opts.profileId,
        sessionId: this.sessionId,
        limit: 5,
      });
      await this.events.emit({
        sessionId: this.sessionId,
        type: "memory.retrieved",
        turnId: turn.id,
        payload: { count: memory.items.length, providerId: memory.providerId },
      });

      await this.opts.memory.commitTurn({
        profileId: this.opts.profileId,
        sessionId: this.sessionId,
        turnId: turn.id,
        role: "user",
        text,
        metadata: {},
      });

      // Lightweight tool intent for simulator: "delegate:category:description"
      const delegation = parseDelegateIntent(text);
      if (delegation) {
        await this.runDelegation(turn, delegation.category, delegation.description);
        return;
      }
      if (looksLikeDocsIngestTask(text)) {
        await this.runDelegation(turn, "research", text);
        return;
      }
      if (looksLikeXIngestTask(text)) {
        await this.runDelegation(turn, "research", text);
        return;
      }

      await this.fsm.transition("GeneratingResponse", "llm.start", { turnId: turn.id });
      const responseId = this.responseLedger.beginResponse(this.sessionId, turn.id);
      this.currentResponseId = responseId;

      const prompt = this.promptAssembler.assemble({
        systemInstructions: this.config.systemInstructions,
        extraSystem: this.turnExtraSystem,
        currentUserTurn: text,
        recentConversation: this.recentTurns
          .slice(0, -1)
          .map((t) => ({ role: t.role, text: t.text })),
        personaContext: this.opts.personaContext,
        retrievedMemory: memory.items,
        availableCapabilities: ["delegate_task"],
        mode: "initial",
        lateAddenda: [],
        agentResults: [],
      });

      const assistantText = await this.generateWithFailover(prompt.messages, responseId, turn.id);
      await this.responseLedger.commit(responseId, assistantText);

      // Process any addenda that arrived during generation.
      if (this.pendingAddenda.length > 0) {
        await this.generateAddendumSegments(turn, responseId);
      }

      const committed = this.responseLedger.getCommittedText(responseId);
      const interrupted = await this.speak(responseId, turn.id, committed);
      if (interrupted || this.interruptedDuringDelivery) {
        // Interruption handler owns the remainder of the turn lifecycle.
        return;
      }

      const assistantTurn: ConversationTurn = {
        id: createId("turn"),
        sessionId: this.sessionId,
        role: "assistant",
        text: this.responseLedger.getDeliveredText(responseId) || committed,
        createdAt: this.opts.clock.nowIso(),
        isAddendum: false,
        metadata: {},
      };
      this.recentTurns.push(assistantTurn);
      await this.opts.persistence.turns.append(assistantTurn);
      await this.opts.memory.commitTurn({
        profileId: this.opts.profileId,
        sessionId: this.sessionId,
        turnId: assistantTurn.id,
        role: "assistant",
        text: assistantTurn.text,
        metadata: {},
      });

      if (this.fsm.getState() !== "Cancelled") {
        if (this.fsm.canTransition("Listening")) {
          await this.fsm.transition("Listening", "turn.complete");
        } else if (this.fsm.canTransition("Idle")) {
          await this.fsm.transition("Idle", "turn.complete");
        } else {
          await this.fsm.force("Listening", "turn.complete");
        }
      }
    } catch (err) {
      span.recordException(err);
      await this.fail(err);
      throw err;
    } finally {
      span.end();
    }
  }

  private async handleAddendum(text: string): Promise<void> {
    this.pendingAddenda.push(text);
    const turn: ConversationTurn = {
      id: createId("turn"),
      sessionId: this.sessionId,
      role: "user",
      text,
      createdAt: this.opts.clock.nowIso(),
      isAddendum: true,
      parentTurnId: this.currentTurnId,
      metadata: { kind: "late_addendum" },
    };
    this.recentTurns.push(turn);
    await this.opts.persistence.turns.append(turn);
    await this.events.emit({
      sessionId: this.sessionId,
      type: "turn.addendum",
      turnId: turn.id,
      responseId: this.currentResponseId,
      payload: { text },
    });

    if (this.fsm.getState() === "GeneratingResponse") {
      await this.fsm.transition("UserAddendumReceived", "user.addendum", {
        turnId: turn.id,
        responseId: this.currentResponseId,
      });
      // Do not cancel in-flight generation. Return to generating to continue.
      if (this.fsm.canTransition("GeneratingResponse")) {
        await this.fsm.transition("GeneratingResponse", "addendum.recorded", {
          turnId: turn.id,
          responseId: this.currentResponseId,
        });
      }
    }
  }

  private async generateAddendumSegments(
    parentTurn: ConversationTurn,
    responseId: string,
  ): Promise<void> {
    const addenda = [...this.pendingAddenda];
    this.pendingAddenda = [];
    const spoken = this.responseLedger.getDeliveredText(responseId);
    const proposed = this.responseLedger.getProposedText(responseId);
    const unspoken = this.responseLedger.getUnspokenRemainder(responseId);

    const prompt = this.promptAssembler.assemble({
      systemInstructions: this.config.systemInstructions,
      extraSystem: this.turnExtraSystem,
      currentUserTurn: addenda.join("\n"),
      recentConversation: this.recentTurns.map((t) => ({ role: t.role, text: t.text })),
      personaContext: this.opts.personaContext,
      retrievedMemory: [],
      existingResponseState: {
        spokenText: spoken,
        unspokenText: unspoken,
        proposedText: proposed,
        isGenerating: true,
        isSpeaking: false,
      },
      lateAddenda: addenda,
      mode: "addendum",
      agentResults: [],
      availableCapabilities: ["delegate_task"],
    });

    // Keep original; append supplementary segment.
    const segmentText = await this.generateWithFailover(
      prompt.messages,
      responseId,
      parentTurn.id,
      "addendum",
    );
    const combined = `${this.responseLedger.getCommittedText(responseId)}\n${segmentText}`.trim();
    await this.responseLedger.commit(responseId, combined);
  }

  private async handleSpeechOverlap(input: UserUtteranceInput): Promise<void> {
    const stt: SttResult = {
      text: input.text,
      isFinal: true,
      utteranceKind: input.utteranceKind,
    };
    const classification = await this.backchannelClassifier.classify(stt);

    if (classification.isBackchannel && !input.forcedArbitration) {
      await this.fsm.transition("UserBackchannelReceived", "user.backchannel");
      await this.events.emit({
        sessionId: this.sessionId,
        type: "interruption.backchannel",
        turnId: this.currentTurnId,
        responseId: this.currentResponseId,
        payload: { text: input.text, classification },
      });
      await this.fsm.transition("AssistantSpeaking", "backchannel.continue");
      return;
    }

    // Genuine interruption: stop output promptly.
    this.interruptedDuringDelivery = true;
    this.deliveryAbort?.abort({ reason: "interruption" satisfies CancellationReason });
    this.isSpeaking = false;

    await this.fsm.transition("GenuineInterruptionReceived", "user.interrupt");
    await this.events.emit({
      sessionId: this.sessionId,
      type: "interruption.detected",
      turnId: this.currentTurnId,
      responseId: this.currentResponseId,
      payload: { text: input.text },
    });
    await this.fsm.transition("InterruptionArbitration", "arbitrate");

    const responseId = this.currentResponseId!;
    const delivered = this.responseLedger.getDeliveredText(responseId);
    const unspoken = this.responseLedger.getUnspokenRemainder(responseId);

    const outcome = await this.interruptionArbiter.arbitrate({
      deliveredText: delivered,
      unspokenText: unspoken,
      interruptionText: input.text,
      forcedOutcome: input.forcedArbitration,
    });

    await this.events.emit({
      sessionId: this.sessionId,
      type: "interruption.arbitrated",
      turnId: this.currentTurnId,
      responseId,
      payload: { outcome, delivered, unspoken },
    });

    const interruptTurn = await this.commitUserTurn(input.text, {
      isAddendum: false,
      metadata: { kind: "interruption", outcome },
    });

    switch (outcome) {
      case "treat_as_backchannel": {
        // Resume delivery of remainder on a fresh delivery controller.
        this.deliveryAbort = new AbortController();
        await this.fsm.transition("AssistantSpeaking", "arbiter.backchannel");
        this.isSpeaking = true;
        await this.deliverText(responseId, interruptTurn.id, unspoken);
        this.isSpeaking = false;
        await this.fsm.force("Listening", "speech.complete");
        break;
      }
      case "ask_clarification": {
        if (unspoken) {
          await this.responseLedger.abandon(responseId, unspoken, "interruption");
        }
        await this.fsm.transition("GeneratingResponse", "arbiter.clarify", {
          turnId: interruptTurn.id,
        });
        await this.answerAfterInterruption(interruptTurn, responseId, "clarification", {
          spokenText: delivered,
          unspokenText: "",
          outcome,
        });
        break;
      }
      case "finish_sentence_then_answer": {
        const sentence = firstSentence(unspoken);
        const rest = unspoken.slice(sentence.length);
        this.deliveryAbort = new AbortController();
        await this.fsm.transition("AssistantSpeaking", "arbiter.finish_sentence");
        this.isSpeaking = true;
        if (sentence) {
          await this.deliverText(responseId, interruptTurn.id, sentence);
        }
        this.isSpeaking = false;
        if (rest) {
          await this.responseLedger.abandon(responseId, rest, "interruption");
        }
        await this.fsm.transition("GeneratingResponse", "arbiter.after_sentence", {
          turnId: interruptTurn.id,
        });
        await this.answerAfterInterruption(interruptTurn, responseId, "replacement", {
          spokenText: delivered + sentence,
          unspokenText: "",
          outcome,
        });
        break;
      }
      case "resume_then_answer": {
        await this.fsm.transition("ResponseResumption", "arbiter.resume");
        if (unspoken) {
          await this.responseLedger.markResumed(responseId, unspoken);
        }
        this.deliveryAbort = new AbortController();
        await this.fsm.transition("AssistantSpeaking", "resume.speak");
        this.isSpeaking = true;
        await this.deliverText(responseId, interruptTurn.id, unspoken);
        this.isSpeaking = false;
        await this.fsm.transition("GeneratingResponse", "arbiter.after_resume", {
          turnId: interruptTurn.id,
        });
        await this.answerAfterInterruption(interruptTurn, responseId, "continuation", {
          spokenText: delivered + unspoken,
          unspokenText: "",
          outcome,
        });
        break;
      }
      case "abandon_and_answer":
      default: {
        if (unspoken) {
          await this.responseLedger.abandon(responseId, unspoken, "interruption");
        }
        await this.fsm.transition("GeneratingResponse", "arbiter.abandon", {
          turnId: interruptTurn.id,
        });
        await this.answerAfterInterruption(interruptTurn, responseId, "replacement", {
          spokenText: delivered,
          unspokenText: "",
          outcome,
        });
        break;
      }
    }
  }

  private async answerAfterInterruption(
    turn: ConversationTurn,
    priorResponseId: string,
    mode: "replacement" | "continuation" | "clarification",
    ctx: { spokenText: string; unspokenText: string; outcome: ArbitrationOutcome },
  ): Promise<void> {
    const responseId = this.responseLedger.beginResponse(this.sessionId, turn.id);
    this.currentResponseId = responseId;
    const prompt = this.promptAssembler.assemble({
      systemInstructions: this.config.systemInstructions,
      extraSystem: this.turnExtraSystem,
      currentUserTurn: turn.text,
      recentConversation: this.recentTurns.map((t) => ({ role: t.role, text: t.text })),
      personaContext: this.opts.personaContext,
      retrievedMemory: [],
      existingResponseState: {
        spokenText: ctx.spokenText,
        unspokenText: ctx.unspokenText,
        proposedText: "",
        isGenerating: false,
        isSpeaking: false,
      },
      interruptionState: {
        interrupted: true,
        userInterruptionText: turn.text,
        arbitrationOutcome: ctx.outcome,
      },
      mode,
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: ["delegate_task"],
    });
    const text = await this.generateWithFailover(prompt.messages, responseId, turn.id);
    await this.responseLedger.commit(responseId, text);
    await this.speak(responseId, turn.id, text);

    const assistantTurn: ConversationTurn = {
      id: createId("turn"),
      sessionId: this.sessionId,
      role: "assistant",
      text: this.responseLedger.getDeliveredText(responseId) || text,
      createdAt: this.opts.clock.nowIso(),
      isAddendum: false,
      metadata: { priorResponseId, outcome: ctx.outcome },
    };
    this.recentTurns.push(assistantTurn);
    await this.opts.persistence.turns.append(assistantTurn);
    await this.fsm.force("Listening", "interrupt.handled");
  }

  private async runDelegation(
    turn: ConversationTurn,
    category: TaskCategory,
    description: string,
  ): Promise<void> {
    await this.fsm.transition("AgentTaskDelegated", "agent.delegate", { turnId: turn.id });
    const correlationId = createId("corr");
    await this.fsm.transition("WaitingForAgentResult", "agent.wait", { turnId: turn.id });
    await this.events.emit({
      sessionId: this.sessionId,
      type: "agent.delegated",
      turnId: turn.id,
      correlationId,
      payload: { category, description },
    });

    const result = await this.opts.agents.delegate({
      correlationId,
      taskDescription: description,
      taskCategory: category,
      conversationContext: this.recentTurns.map((t) => `${t.role}: ${t.text}`).join("\n"),
      permissions: ["agent.delegate"],
      requestedOutputFormat: "text",
      confirmationRequired: false,
      timeoutMs:
        category === "research" || category === "browser" || category === "computer_use"
          ? 600_000
          : 30_000,
    });

    if (result.status === "failed") {
      await this.events.emit({
        sessionId: this.sessionId,
        type: "agent.failed",
        turnId: turn.id,
        correlationId,
        payload: { ...result },
      });
    } else {
      await this.events.emit({
        sessionId: this.sessionId,
        type: "agent.completed",
        turnId: turn.id,
        correlationId,
        payload: { ...result },
      });
    }

    await this.fsm.transition("GeneratingResponse", "agent.result", { turnId: turn.id });
    const responseId = this.responseLedger.beginResponse(this.sessionId, turn.id);
    this.currentResponseId = responseId;
    const prompt = this.promptAssembler.assemble({
      systemInstructions: this.config.systemInstructions,
      extraSystem: this.turnExtraSystem,
      currentUserTurn: turn.text,
      recentConversation: this.recentTurns.map((t) => ({ role: t.role, text: t.text })),
      personaContext: this.opts.personaContext,
      retrievedMemory: [],
      agentResults: [result],
      mode: "initial",
      lateAddenda: [],
      availableCapabilities: ["delegate_task"],
    });
    const text = await this.generateWithFailover(prompt.messages, responseId, turn.id);
    await this.responseLedger.commit(responseId, text);
    await this.speak(responseId, turn.id, text);
    const assistantTurn: ConversationTurn = {
      id: createId("turn"),
      sessionId: this.sessionId,
      role: "assistant",
      text,
      createdAt: this.opts.clock.nowIso(),
      isAddendum: false,
      metadata: { agent: result },
    };
    this.recentTurns.push(assistantTurn);
    await this.opts.persistence.turns.append(assistantTurn);
    await this.fsm.force("Listening", "delegation.complete");
  }

  private async transcribe(input: UserUtteranceInput): Promise<SttResult> {
    if (this.config.pipeline.mode === "unified") {
      // Unified path still receives text in the simulator; STT is owned by the stack.
      return {
        text: input.text,
        isFinal: true,
        utteranceKind: input.utteranceKind ?? "speech",
      };
    }
    const sttId = this.sttFailover?.getActiveProviderId();
    if (!sttId) {
      return { text: input.text, isFinal: true, utteranceKind: input.utteranceKind ?? "speech" };
    }
    try {
      const result = await this.opts.providers.getStt(sttId).transcribe({
        audioRef: input.audioRef ?? `text:${input.text}`,
        signal: undefined,
      });
      await this.sttFailover?.recordSuccess(sttId);
      return {
        ...result,
        text: result.text || input.text,
        utteranceKind: input.utteranceKind ?? result.utteranceKind,
      };
    } catch (err) {
      const failureClass = extractFailureClass(err);
      await this.sttFailover?.recordFailure(sttId, failureClass);
      return { text: input.text, isFinal: true, utteranceKind: input.utteranceKind ?? "speech" };
    }
  }

  private async generateWithFailover(
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[],
    responseId: string,
    turnId: string,
    segmentKind: "primary" | "addendum" = "primary",
  ): Promise<string> {
    this.isGenerating = true;
    this.generationAbort = new AbortController();
    try {
      if (this.config.pipeline.mode === "unified") {
        return await this.generateUnified(messages, responseId, turnId, segmentKind);
      }
      await this.llmFailover?.maybeRestorePrimary();
      const maxAttempts = this.llmFailover?.getState().orderedProviderIds.length ?? 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const llmId = this.llmFailover!.getActiveProviderId();
        try {
          const llm = this.opts.providers.getLlm(llmId);
          let text = "";
          let toolCall: { toolName?: string; toolArgs?: Record<string, unknown> } | undefined;
          for await (const chunk of llm.generateStream({
            messages,
            signal: this.generationAbort.signal,
            correlationId: turnId,
            imageDataUrls: this.turnImageDataUrls,
            tools: [
              {
                name: "delegate_task",
                description:
                  "Delegate an external action such as household calendar/camera/approvals, ingesting X.com links, coding, or email.",
                parameters: {
                  type: "object",
                  properties: {
                    category: { type: "string" },
                    taskDescription: { type: "string" },
                  },
                  required: ["category", "taskDescription"],
                },
              },
            ],
          })) {
            if (chunk.type === "error") {
              throw Object.assign(new Error(chunk.error ?? "llm error"), {
                failureClass: chunk.failureClass ?? "unknown",
              });
            }
            if (chunk.type === "token" && chunk.text) {
              text += chunk.text;
              await this.responseLedger.appendProposed(responseId, chunk.text);
              this.turnOnToken?.(chunk.text);
            }
            if (chunk.type === "tool_call") {
              toolCall = { toolName: chunk.toolName, toolArgs: chunk.toolArgs };
            }
          }
          if (toolCall?.toolName === "delegate_task") {
            const description = String(toolCall.toolArgs?.taskDescription ?? "");
            const category = (toolCall.toolArgs?.category as TaskCategory | undefined) ?? "research";
            if (description) {
              const result = await this.opts.agents.delegate({
                correlationId: turnId,
                taskDescription: description,
                taskCategory: category,
                conversationContext: messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
                permissions: ["agent.delegate"],
                requestedOutputFormat: "text",
                confirmationRequired: false,
                timeoutMs: 600_000,
              });
              text = result.output || result.error || text;
            }
          }
          if (segmentKind === "addendum") {
            await this.responseLedger.addSegment(responseId, "addendum", text);
          }
          await this.llmFailover?.recordSuccess(llmId);
          return text;
        } catch (err) {
          lastError = err;
          const failureClass = extractFailureClass(err);
          await this.llmFailover?.recordFailure(llmId, failureClass);
        }
      }
      throw lastError ?? new Error("LLM generation failed");
    } finally {
      this.isGenerating = false;
    }
  }

  private async generateUnified(
    messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[],
    responseId: string,
    turnId: string,
    segmentKind: "primary" | "addendum",
  ): Promise<string> {
    const userText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const maxAttempts = this.unifiedFailover?.getState().orderedProviderIds.length ?? 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const id = this.unifiedFailover!.getActiveProviderId();
      try {
        const provider = this.opts.providers.getUnified(id);
        let text = "";
        for await (const chunk of provider.respond(userText, {
          instructions: messages.find((m) => m.role === "system")?.content,
          signal: this.generationAbort?.signal,
        })) {
          if (chunk.type === "error") {
            throw Object.assign(new Error(chunk.error ?? "unified error"), {
              failureClass: chunk.failureClass ?? "unknown",
            });
          }
          if (chunk.type === "token" && chunk.text) {
            text += chunk.text;
            await this.responseLedger.appendProposed(responseId, chunk.text);
            this.turnOnToken?.(chunk.text);
          }
        }
        if (segmentKind === "addendum") {
          await this.responseLedger.addSegment(responseId, "addendum", text);
        }
        await this.unifiedFailover?.recordSuccess(id);
        return text;
      } catch (err) {
        lastError = err;
        await this.unifiedFailover?.recordFailure(id, extractFailureClass(err));
      }
    }
    throw lastError ?? new Error("Unified generation failed");
  }

  /** @returns true if delivery was interrupted */
  private async speak(responseId: string, turnId: string, text: string): Promise<boolean> {
    if (!text) return false;
    this.interruptedDuringDelivery = false;
    await this.fsm.transition("SynthesizingSpeech", "tts.start", { turnId, responseId });

    if (this.config.pipeline.mode !== "unified") {
      const ttsId = this.ttsFailover?.getActiveProviderId();
      if (ttsId) {
        try {
          await this.responseLedger.submitToTts(responseId, text);
          for await (const chunk of this.opts.providers.getTts(ttsId).synthesize({ text })) {
            await this.responseLedger.bufferAudio(responseId, chunk.text);
          }
          await this.ttsFailover?.recordSuccess(ttsId);
        } catch (err) {
          await this.ttsFailover?.recordFailure(ttsId, extractFailureClass(err));
          await this.responseLedger.submitToTts(responseId, text);
          await this.responseLedger.bufferAudio(responseId, text);
        }
      } else {
        await this.responseLedger.submitToTts(responseId, text);
        await this.responseLedger.bufferAudio(responseId, text);
      }
    } else {
      await this.responseLedger.submitToTts(responseId, text);
      await this.responseLedger.bufferAudio(responseId, text);
    }

    await this.fsm.transition("AssistantSpeaking", "tts.play", { turnId, responseId });
    this.isSpeaking = true;
    this.deliveryAbort = new AbortController();
    try {
      await this.deliverText(responseId, turnId, text);
      return this.interruptedDuringDelivery;
    } catch (err) {
      if (isAbortWithReason(err, "interruption") || this.interruptedDuringDelivery) {
        return true;
      }
      throw err;
    } finally {
      this.isSpeaking = false;
    }
  }

  private async deliverText(responseId: string, turnId: string, text: string): Promise<void> {
    const signal = this.deliveryAbort?.signal;
    let offset = 0;
    while (offset < text.length) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("aborted");
      }
      const chunk = text.slice(offset, offset + this.speech.charsPerChunk);
      offset += chunk.length;
      await this.responseLedger.markDelivered(responseId, chunk);
      this.lastDeliveredCommitted = this.responseLedger.getDeliveredText(responseId);
      await this.opts.clock.sleep(this.speech.chunkDurationMs, signal);
    }
    void turnId;
  }

  private async commitUserTurn(
    text: string,
    opts?: { isAddendum?: boolean; metadata?: Record<string, unknown> },
  ): Promise<ConversationTurn> {
    const turn: ConversationTurn = {
      id: createId("turn"),
      sessionId: this.sessionId,
      role: "user",
      text,
      createdAt: this.opts.clock.nowIso(),
      isAddendum: opts?.isAddendum ?? false,
      metadata: opts?.metadata ?? {},
    };
    this.currentTurnId = turn.id;
    this.recentTurns.push(turn);
    await this.opts.persistence.turns.append(turn);
    await this.events.emit({
      sessionId: this.sessionId,
      type: "turn.committed",
      turnId: turn.id,
      payload: { text, isAddendum: turn.isAddendum },
    });
    return turn;
  }

  private initFailovers(): void {
    const probe = async (providerId: string) => {
      const manifests = this.opts.providers.listManifests();
      const kind = manifests.get(providerId)?.kind;
      try {
        if (kind === "llm") return this.opts.providers.getLlm(providerId).healthCheck();
        if (kind === "stt") return this.opts.providers.getStt(providerId).healthCheck();
        if (kind === "tts") return this.opts.providers.getTts(providerId).healthCheck();
        if (kind === "unified") return this.opts.providers.getUnified(providerId).healthCheck();
      } catch {
        /* fall through */
      }
      return {
        providerId,
        status: "unknown" as const,
        checkedAt: this.opts.clock.nowIso(),
      };
    };

    const p = this.config.pipeline;
    if (p.mode === "unified" && p.unifiedPriority) {
      this.unifiedFailover = new StickyFailoverController(
        this.sessionId,
        p.unifiedPriority,
        this.opts.clock,
        this.events,
        probe,
      );
      this.llmFailover = undefined;
      this.sttFailover = undefined;
      this.ttsFailover = undefined;
    } else {
      this.llmFailover = p.llmPriority
        ? new StickyFailoverController(
            this.sessionId,
            ensureSettings(p.llmPriority),
            this.opts.clock,
            this.events,
            probe,
          )
        : undefined;
      this.sttFailover = p.sttPriority
        ? new StickyFailoverController(
            this.sessionId,
            ensureSettings(p.sttPriority),
            this.opts.clock,
            this.events,
            probe,
          )
        : undefined;
      this.ttsFailover = p.ttsPriority
        ? new StickyFailoverController(
            this.sessionId,
            ensureSettings(p.ttsPriority),
            this.opts.clock,
            this.events,
            probe,
          )
        : undefined;
      this.unifiedFailover = undefined;
    }
  }

  private async fail(err: unknown): Promise<void> {
    await this.events.emit({
      sessionId: this.sessionId,
      type: "error",
      turnId: this.currentTurnId,
      responseId: this.currentResponseId,
      payload: { message: err instanceof Error ? err.message : String(err) },
    });
    if (this.fsm.canTransition("Failed")) {
      await this.fsm.transition("Failed", "error");
    } else {
      await this.fsm.force("Failed", "error");
    }
  }
}

function ensureSettings(list: ProviderPriorityList): ProviderPriorityList {
  return list;
}

function extractFailureClass(err: unknown): ProviderFailureClass {
  if (err && typeof err === "object" && "failureClass" in err) {
    return (err as { failureClass: ProviderFailureClass }).failureClass;
  }
  if (err && typeof err === "object" && "reason" in err) {
    const reason = (err as { reason: CancellationReason }).reason;
    if (reason === "provider_timeout") return "timeout_total";
  }
  return "unknown";
}

function isAbortWithReason(err: unknown, reason: CancellationReason): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { reason?: string }).reason === reason;
}

function parseDelegateIntent(
  text: string,
): { category: TaskCategory; description: string } | undefined {
  const match = text.match(/^delegate:([a-z_]+):(.+)$/i);
  if (!match) return undefined;
  const category = match[1] as TaskCategory;
  const description = match[2]?.trim() ?? "";
  return { category, description };
}
