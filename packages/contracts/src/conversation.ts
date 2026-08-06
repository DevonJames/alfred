import { z } from "zod";
import { CancellationReasonSchema } from "./cancellation.js";

export const ConversationStateSchema = z.enum([
  "Idle",
  "Listening",
  "UserSpeechDetected",
  "Transcribing",
  "UserTurnCommitted",
  "RetrievingMemory",
  "GeneratingResponse",
  "SynthesizingSpeech",
  "AssistantSpeaking",
  "UserAddendumReceived",
  "UserBackchannelReceived",
  "GenuineInterruptionReceived",
  "InterruptionArbitration",
  "ResponseResumption",
  "AgentTaskDelegated",
  "WaitingForAgentResult",
  "Failed",
  "Recovering",
  "Cancelled",
]);
export type ConversationState = z.infer<typeof ConversationStateSchema>;

export const TurnRoleSchema = z.enum(["user", "assistant", "system"]);
export type TurnRole = z.infer<typeof TurnRoleSchema>;

export const ConversationTurnSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: TurnRoleSchema,
  text: z.string(),
  createdAt: z.string().datetime(),
  isAddendum: z.boolean().default(false),
  parentTurnId: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const ResponseSegmentKindSchema = z.enum([
  "primary",
  "addendum",
  "continuation",
  "correction",
  "replacement",
  "clarification",
  "resumption",
]);
export type ResponseSegmentKind = z.infer<typeof ResponseSegmentKindSchema>;

export const ResponseSegmentSchema = z.object({
  id: z.string(),
  responseId: z.string(),
  kind: ResponseSegmentKindSchema,
  text: z.string(),
  createdAt: z.string().datetime(),
});
export type ResponseSegment = z.infer<typeof ResponseSegmentSchema>;

export const LedgerBucketSchema = z.enum([
  "proposed",
  "committed",
  "submitted_to_tts",
  "audio_buffered",
  "delivered",
  "unspoken",
  "abandoned",
  "resumed",
]);
export type LedgerBucket = z.infer<typeof LedgerBucketSchema>;

export const ResponseLedgerEntrySchema = z.object({
  id: z.string(),
  responseId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  segmentId: z.string().optional(),
  bucket: LedgerBucketSchema,
  text: z.string(),
  at: z.string().datetime(),
  cancellationReason: CancellationReasonSchema.optional(),
  note: z.string().optional(),
});
export type ResponseLedgerEntry = z.infer<typeof ResponseLedgerEntrySchema>;

export const ArbitrationOutcomeSchema = z.enum([
  "abandon_and_answer",
  "finish_sentence_then_answer",
  "resume_then_answer",
  "treat_as_backchannel",
  "ask_clarification",
]);
export type ArbitrationOutcome = z.infer<typeof ArbitrationOutcomeSchema>;

export const BackchannelClassificationSchema = z.object({
  isBackchannel: z.boolean(),
  confidence: z.number().min(0).max(1).default(0.5),
  reason: z.string().optional(),
});
export type BackchannelClassification = z.infer<typeof BackchannelClassificationSchema>;
