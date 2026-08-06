import type { ConversationState } from "@alfred/contracts";
import type { EventLedger } from "./event-ledger.js";

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ConversationState,
    public readonly to: ConversationState,
    public readonly trigger: string,
  ) {
    super(`Invalid transition ${from} -> ${to} (trigger=${trigger})`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Allowed transitions. Intentionally explicit and inspectable.
 * Recovery / cancel edges are broad so orchestrators can always exit safely.
 */
const ALLOWED: Record<ConversationState, ConversationState[]> = {
  Idle: ["Listening", "Cancelled"],
  Listening: ["UserSpeechDetected", "Cancelled", "Failed"],
  UserSpeechDetected: ["Transcribing", "UserTurnCommitted", "Cancelled", "Failed"],
  Transcribing: ["UserTurnCommitted", "Failed", "Recovering", "Cancelled"],
  UserTurnCommitted: ["RetrievingMemory", "GeneratingResponse", "AgentTaskDelegated", "Cancelled"],
  RetrievingMemory: [
    "GeneratingResponse",
    "AgentTaskDelegated",
    "Failed",
    "Recovering",
    "Cancelled",
  ],
  GeneratingResponse: [
    "UserAddendumReceived",
    "SynthesizingSpeech",
    "AssistantSpeaking",
    "AgentTaskDelegated",
    "Failed",
    "Recovering",
    "Cancelled",
  ],
  UserAddendumReceived: ["GeneratingResponse", "Cancelled", "Failed"],
  SynthesizingSpeech: ["AssistantSpeaking", "Failed", "Recovering", "Cancelled"],
  AssistantSpeaking: [
    "UserBackchannelReceived",
    "GenuineInterruptionReceived",
    "GeneratingResponse",
    "Idle",
    "Listening",
    "Cancelled",
    "Failed",
  ],
  UserBackchannelReceived: ["AssistantSpeaking", "Listening", "Idle", "Cancelled"],
  GenuineInterruptionReceived: ["InterruptionArbitration", "Cancelled", "Failed"],
  InterruptionArbitration: [
    "GeneratingResponse",
    "ResponseResumption",
    "AssistantSpeaking",
    "Listening",
    "Idle",
    "Cancelled",
    "Failed",
  ],
  ResponseResumption: [
    "SynthesizingSpeech",
    "AssistantSpeaking",
    "GeneratingResponse",
    "Cancelled",
  ],
  AgentTaskDelegated: ["WaitingForAgentResult", "Cancelled", "Failed"],
  WaitingForAgentResult: ["GeneratingResponse", "Failed", "Recovering", "Cancelled"],
  Failed: ["Recovering", "Idle", "Listening", "Cancelled"],
  Recovering: ["Idle", "Listening", "GeneratingResponse", "Cancelled", "Failed"],
  Cancelled: ["Idle"],
};

export class ConversationStateMachine {
  private state: ConversationState = "Idle";

  constructor(
    private readonly sessionId: string,
    private readonly events: EventLedger,
  ) {}

  getState(): ConversationState {
    return this.state;
  }

  canTransition(to: ConversationState): boolean {
    return ALLOWED[this.state].includes(to);
  }

  async transition(
    to: ConversationState,
    trigger: string,
    opts?: { turnId?: string; responseId?: string; correlationId?: string; causationId?: string },
  ): Promise<ConversationState> {
    if (!this.canTransition(to)) {
      throw new InvalidTransitionError(this.state, to, trigger);
    }
    const from = this.state;
    this.state = to;
    await this.events.emit({
      sessionId: this.sessionId,
      type: "state.transition",
      turnId: opts?.turnId,
      responseId: opts?.responseId,
      correlationId: opts?.correlationId,
      causationId: opts?.causationId,
      payload: { from, to, trigger },
    });
    return this.state;
  }

  /** Force state for recovery paths that must leave Cancelled/Failed cleanly. */
  async force(
    to: ConversationState,
    trigger: string,
    opts?: { turnId?: string; responseId?: string },
  ): Promise<void> {
    const from = this.state;
    this.state = to;
    await this.events.emit({
      sessionId: this.sessionId,
      type: "state.transition",
      turnId: opts?.turnId,
      responseId: opts?.responseId,
      payload: { from, to, trigger, forced: true },
    });
  }
}

export function allowedTransitions(): Readonly<Record<ConversationState, ConversationState[]>> {
  return ALLOWED;
}
