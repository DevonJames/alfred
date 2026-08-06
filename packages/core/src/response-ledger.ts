import {
  createId,
  type CancellationReason,
  type LedgerBucket,
  type ResponseLedgerEntry,
  type ResponseSegment,
  type ResponseSegmentKind,
} from "@alfred/contracts";
import type { ResponseLedgerRepository } from "@alfred/persistence";
import type { Clock } from "./clock.js";
import type { EventLedger } from "./event-ledger.js";

export interface ResponseLedgerSnapshot {
  responseId: string;
  sessionId: string;
  turnId: string;
  segments: ResponseSegment[];
  proposedText: string;
  committedText: string;
  submittedToTtsText: string;
  bufferedText: string;
  deliveredText: string;
  unspokenText: string;
  abandonedText: string;
  resumedText: string;
  cancellationReasons: CancellationReason[];
}

/**
 * Tracks assistant response materialization separately from a single string.
 */
export class ResponseLedger {
  private readonly segments = new Map<string, ResponseSegment[]>();
  private readonly proposed = new Map<string, string>();
  private readonly committed = new Map<string, string>();
  private readonly submitted = new Map<string, string>();
  private readonly buffered = new Map<string, string>();
  private readonly delivered = new Map<string, string>();
  private readonly abandoned = new Map<string, string>();
  private readonly resumed = new Map<string, string>();
  private readonly cancellations = new Map<string, CancellationReason[]>();
  private readonly meta = new Map<string, { sessionId: string; turnId: string }>();

  constructor(
    private readonly repo: ResponseLedgerRepository,
    private readonly events: EventLedger,
    private readonly clock: Clock,
  ) {}

  beginResponse(sessionId: string, turnId: string, responseId = createId("resp")): string {
    this.meta.set(responseId, { sessionId, turnId });
    this.segments.set(responseId, []);
    this.proposed.set(responseId, "");
    this.committed.set(responseId, "");
    this.submitted.set(responseId, "");
    this.buffered.set(responseId, "");
    this.delivered.set(responseId, "");
    this.abandoned.set(responseId, "");
    this.resumed.set(responseId, "");
    this.cancellations.set(responseId, []);
    return responseId;
  }

  async addSegment(
    responseId: string,
    kind: ResponseSegmentKind,
    text: string,
  ): Promise<ResponseSegment> {
    const meta = this.requireMeta(responseId);
    const segment: ResponseSegment = {
      id: createId("seg"),
      responseId,
      kind,
      text,
      createdAt: this.clock.nowIso(),
    };
    const list = this.segments.get(responseId) ?? [];
    list.push(segment);
    this.segments.set(responseId, list);
    await this.record(responseId, meta.sessionId, meta.turnId, "proposed", text, segment.id);
    this.proposed.set(responseId, (this.proposed.get(responseId) ?? "") + text);
    return segment;
  }

  async appendProposed(responseId: string, text: string, segmentId?: string): Promise<void> {
    const meta = this.requireMeta(responseId);
    this.proposed.set(responseId, (this.proposed.get(responseId) ?? "") + text);
    await this.record(responseId, meta.sessionId, meta.turnId, "proposed", text, segmentId);
    await this.events.emit({
      sessionId: meta.sessionId,
      type: "response.proposed",
      turnId: meta.turnId,
      responseId,
      payload: { text },
    });
  }

  async commit(responseId: string, text?: string): Promise<void> {
    const meta = this.requireMeta(responseId);
    const value = text ?? this.proposed.get(responseId) ?? "";
    this.committed.set(responseId, value);
    await this.record(responseId, meta.sessionId, meta.turnId, "committed", value);
    await this.events.emit({
      sessionId: meta.sessionId,
      type: "response.committed",
      turnId: meta.turnId,
      responseId,
      payload: { text: value },
    });
  }

  async submitToTts(responseId: string, text: string): Promise<void> {
    const meta = this.requireMeta(responseId);
    this.submitted.set(responseId, (this.submitted.get(responseId) ?? "") + text);
    await this.record(responseId, meta.sessionId, meta.turnId, "submitted_to_tts", text);
    await this.events.emit({
      sessionId: meta.sessionId,
      type: "response.tts_submitted",
      turnId: meta.turnId,
      responseId,
      payload: { text },
    });
  }

  async bufferAudio(responseId: string, text: string): Promise<void> {
    const meta = this.requireMeta(responseId);
    this.buffered.set(responseId, (this.buffered.get(responseId) ?? "") + text);
    await this.record(responseId, meta.sessionId, meta.turnId, "audio_buffered", text);
    await this.events.emit({
      sessionId: meta.sessionId,
      type: "response.buffered",
      turnId: meta.turnId,
      responseId,
      payload: { text },
    });
  }

  async markDelivered(responseId: string, text: string): Promise<void> {
    const meta = this.requireMeta(responseId);
    this.delivered.set(responseId, (this.delivered.get(responseId) ?? "") + text);
    await this.record(responseId, meta.sessionId, meta.turnId, "delivered", text);
    await this.events.emit({
      sessionId: meta.sessionId,
      type: "response.delivered",
      turnId: meta.turnId,
      responseId,
      payload: { text },
    });
  }

  async abandon(responseId: string, text: string, reason: CancellationReason): Promise<void> {
    const meta = this.requireMeta(responseId);
    this.abandoned.set(responseId, (this.abandoned.get(responseId) ?? "") + text);
    const reasons = this.cancellations.get(responseId) ?? [];
    reasons.push(reason);
    this.cancellations.set(responseId, reasons);
    await this.record(
      responseId,
      meta.sessionId,
      meta.turnId,
      "abandoned",
      text,
      undefined,
      reason,
    );
    await this.events.emit({
      sessionId: meta.sessionId,
      type: "response.abandoned",
      turnId: meta.turnId,
      responseId,
      payload: { text, reason },
    });
  }

  async markResumed(responseId: string, text: string): Promise<void> {
    const meta = this.requireMeta(responseId);
    this.resumed.set(responseId, (this.resumed.get(responseId) ?? "") + text);
    await this.record(responseId, meta.sessionId, meta.turnId, "resumed", text);
    await this.events.emit({
      sessionId: meta.sessionId,
      type: "response.resumed",
      turnId: meta.turnId,
      responseId,
      payload: { text },
    });
  }

  getDeliveredText(responseId: string): string {
    return this.delivered.get(responseId) ?? "";
  }

  getUnspokenRemainder(responseId: string): string {
    const committed = this.committed.get(responseId) ?? this.proposed.get(responseId) ?? "";
    const delivered = this.delivered.get(responseId) ?? "";
    if (!committed.startsWith(delivered)) {
      // Best-effort: if delivery diverged, return committed without delivered prefix match.
      return committed.slice(delivered.length);
    }
    return committed.slice(delivered.length);
  }

  getProposedText(responseId: string): string {
    return this.proposed.get(responseId) ?? "";
  }

  getCommittedText(responseId: string): string {
    return this.committed.get(responseId) ?? "";
  }

  snapshot(responseId: string): ResponseLedgerSnapshot {
    const meta = this.requireMeta(responseId);
    const committed = this.committed.get(responseId) ?? this.proposed.get(responseId) ?? "";
    const delivered = this.delivered.get(responseId) ?? "";
    return {
      responseId,
      sessionId: meta.sessionId,
      turnId: meta.turnId,
      segments: [...(this.segments.get(responseId) ?? [])],
      proposedText: this.proposed.get(responseId) ?? "",
      committedText: committed,
      submittedToTtsText: this.submitted.get(responseId) ?? "",
      bufferedText: this.buffered.get(responseId) ?? "",
      deliveredText: delivered,
      unspokenText: this.getUnspokenRemainder(responseId),
      abandonedText: this.abandoned.get(responseId) ?? "",
      resumedText: this.resumed.get(responseId) ?? "",
      cancellationReasons: [...(this.cancellations.get(responseId) ?? [])],
    };
  }

  private requireMeta(responseId: string): { sessionId: string; turnId: string } {
    const meta = this.meta.get(responseId);
    if (!meta) throw new Error(`Unknown responseId: ${responseId}`);
    return meta;
  }

  private async record(
    responseId: string,
    sessionId: string,
    turnId: string,
    bucket: LedgerBucket,
    text: string,
    segmentId?: string,
    cancellationReason?: CancellationReason,
  ): Promise<void> {
    const entry: ResponseLedgerEntry = {
      id: createId("rle"),
      responseId,
      sessionId,
      turnId,
      segmentId,
      bucket,
      text,
      at: this.clock.nowIso(),
      cancellationReason,
    };
    await this.repo.append(entry);
  }
}
