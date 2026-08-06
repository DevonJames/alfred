import { z } from "zod";
import { ConversationStateSchema } from "./conversation.js";

export const ConversationEventTypeSchema = z.enum([
  "session.started",
  "session.ended",
  "state.transition",
  "turn.committed",
  "turn.addendum",
  "turn.provisional",
  "memory.retrieved",
  "memory.written",
  "response.proposed",
  "response.committed",
  "response.tts_submitted",
  "response.buffered",
  "response.delivered",
  "response.abandoned",
  "response.resumed",
  "stt.start_of_turn",
  "stt.partial_transcript",
  "stt.eager_eot",
  "stt.turn_resumed",
  "stt.end_of_turn",
  "tts.audio_buffered",
  "tts.word_aligned",
  "tts.playback_confirmed",
  "tts.context_closed",
  "latency.mark",
  "interruption.detected",
  "interruption.backchannel",
  "interruption.arbitrated",
  "provider.selected",
  "provider.failed",
  "provider.failover",
  "provider.primary_restored",
  "provider.health_probed",
  "agent.delegated",
  "agent.completed",
  "agent.failed",
  "pipeline.configured",
  "cancellation",
  "error",
]);
export type ConversationEventType = z.infer<typeof ConversationEventTypeSchema>;

/** Named latency markers for voice pipeline measurement. */
export const LatencyMarkNameSchema = z.enum([
  "speech_started_at",
  "last_user_audio_at",
  "eager_eot_at",
  "final_eot_at",
  "first_llm_token_at",
  "first_speakable_chunk_at",
  "first_tts_byte_at",
  "first_audio_buffered_at",
  "first_audio_played_at",
  "interruption_detected_at",
  "audio_stopped_at",
]);
export type LatencyMarkName = z.infer<typeof LatencyMarkNameSchema>;

export const ConversationEventSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  turnId: z.string().optional(),
  responseId: z.string().optional(),
  providerId: z.string().optional(),
  type: ConversationEventTypeSchema,
  timestamp: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
});
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

export const StateTransitionPayloadSchema = z.object({
  from: ConversationStateSchema,
  to: ConversationStateSchema,
  trigger: z.string(),
});
export type StateTransitionPayload = z.infer<typeof StateTransitionPayloadSchema>;
