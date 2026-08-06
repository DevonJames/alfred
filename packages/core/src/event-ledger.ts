import { createId, type ConversationEvent, type ConversationEventType } from "@alfred/contracts";
import type { EventRepository } from "@alfred/persistence";
import type { Clock } from "./clock.js";
import type { Observability } from "./observability.js";

export interface EmitEventInput {
  sessionId: string;
  type: ConversationEventType;
  turnId?: string;
  responseId?: string;
  providerId?: string;
  correlationId?: string;
  causationId?: string;
  payload?: Record<string, unknown>;
}

export class EventLedger {
  private sequence = 0;

  constructor(
    private readonly repo: EventRepository,
    private readonly clock: Clock,
    private readonly observability: Observability,
  ) {}

  async emit(input: EmitEventInput): Promise<ConversationEvent> {
    const event: ConversationEvent = {
      eventId: createId("evt"),
      sessionId: input.sessionId,
      turnId: input.turnId,
      responseId: input.responseId,
      providerId: input.providerId,
      type: input.type,
      timestamp: this.clock.nowIso(),
      sequence: this.sequence++,
      correlationId: input.correlationId,
      causationId: input.causationId,
      payload: input.payload ?? {},
    };
    await this.repo.append(event);
    this.observability.emitEvent(event);
    return event;
  }

  async list(sessionId: string): Promise<ConversationEvent[]> {
    return this.repo.listBySession(sessionId);
  }
}
