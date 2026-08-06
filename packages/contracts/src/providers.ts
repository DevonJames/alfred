import { z } from "zod";
import { SecretRefSchema } from "./secrets.js";

export const ProviderKindSchema = z.enum(["llm", "stt", "tts", "unified"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "unhealthy",
  "unknown",
  "cooldown",
]);
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>;

export const ProviderFailureClassSchema = z.enum([
  "connection",
  "auth",
  "rate_limit",
  "timeout_connection",
  "timeout_first_token",
  "timeout_total",
  "content_filter",
  "invalid_request",
  "upstream_5xx",
  "unavailable",
  "unknown",
]);
export type ProviderFailureClass = z.infer<typeof ProviderFailureClassSchema>;

/** Failures that qualify for sticky failover by default. */
export const FAILOVER_ELIGIBLE_FAILURES: ReadonlySet<ProviderFailureClass> = new Set([
  "connection",
  "timeout_connection",
  "timeout_first_token",
  "timeout_total",
  "rate_limit",
  "upstream_5xx",
  "unavailable",
]);

export const ProviderManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  kind: ProviderKindSchema,
  version: z.string().default("0.1.0"),
  capabilities: z.array(z.string()).default([]),
  /** When kind=unified, the locked component stack identity. */
  unifiedStackId: z.string().optional(),
});
export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

export const ProviderHealthSchema = z.object({
  providerId: z.string(),
  status: ProviderHealthStatusSchema,
  checkedAt: z.string().datetime(),
  latencyMs: z.number().nonnegative().optional(),
  message: z.string().optional(),
  failureClass: ProviderFailureClassSchema.optional(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const FailoverSettingsSchema = z.object({
  connectionTimeoutMs: z.number().int().positive().default(5_000),
  firstTokenTimeoutMs: z.number().int().positive().default(10_000),
  totalRequestTimeoutMs: z.number().int().positive().default(60_000),
  consecutiveFailureThreshold: z.number().int().positive().default(2),
  cooldownMs: z.number().int().nonnegative().default(30_000),
  retryPrimaryIntervalMs: z.number().int().positive().default(300_000),
  /** When true, active provider is pinned and failover is suppressed. */
  manualPin: z.boolean().default(false),
  pinnedProviderId: z.string().optional(),
});
export type FailoverSettings = z.infer<typeof FailoverSettingsSchema>;

export const ProviderPriorityListSchema = z.object({
  modality: ProviderKindSchema,
  orderedProviderIds: z.array(z.string().min(1)).min(1),
  settings: FailoverSettingsSchema.default({}),
});
export type ProviderPriorityList = z.infer<typeof ProviderPriorityListSchema>;

export const ProviderConfigSchema = z.object({
  providerId: z.string(),
  kind: ProviderKindSchema,
  enabled: z.boolean().default(true),
  credentials: SecretRefSchema.optional(),
  options: z.record(z.unknown()).default({}),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const LlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  name: z.string().optional(),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export const LlmReasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);
export type LlmReasoningEffort = z.infer<typeof LlmReasoningEffortSchema>;

/** Alfred conversational presets — mapped to vendor models inside adapters only. */
export const LlmModelPresetSchema = z.enum(["instant", "conversational", "deliberate"]);
export type LlmModelPreset = z.infer<typeof LlmModelPresetSchema>;

export const LlmGenerateRequestSchema = z.object({
  messages: z.array(LlmMessageSchema),
  signal: z.any().optional(),
  correlationId: z.string().optional(),
  reasoningEffort: LlmReasoningEffortSchema.optional(),
  modelPreset: LlmModelPresetSchema.optional(),
  previousResponseId: z.string().optional(),
});
export type LlmGenerateRequest = z.infer<typeof LlmGenerateRequestSchema>;

export const LlmStreamChunkSchema = z.object({
  type: z.enum(["token", "tool_call", "done", "error"]),
  text: z.string().optional(),
  toolName: z.string().optional(),
  toolArgs: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  failureClass: ProviderFailureClassSchema.optional(),
});
export type LlmStreamChunk = z.infer<typeof LlmStreamChunkSchema>;

export interface LLMProvider {
  readonly manifest: ProviderManifest;
  healthCheck(): Promise<ProviderHealth>;
  generateStream(request: LlmGenerateRequest): AsyncIterable<LlmStreamChunk>;
}

export const SttTranscribeRequestSchema = z.object({
  /** Opaque audio reference or simulated transcript source for fakes. */
  audioRef: z.string(),
  language: z.string().optional(),
  signal: z.any().optional(),
});
export type SttTranscribeRequest = z.infer<typeof SttTranscribeRequestSchema>;

export const SttResultSchema = z.object({
  text: z.string(),
  isFinal: z.boolean().default(true),
  confidence: z.number().min(0).max(1).optional(),
  /** Scenario metadata for fake backchannel classification. */
  utteranceKind: z.enum(["speech", "backchannel", "noise"]).optional(),
});
export type SttResult = z.infer<typeof SttResultSchema>;

export const SttTurnEventTypeSchema = z.enum([
  "start_of_turn",
  "partial_transcript",
  "eager_end_of_turn",
  "turn_resumed",
  "end_of_turn",
  "error",
]);
export type SttTurnEventType = z.infer<typeof SttTurnEventTypeSchema>;

export const SttTurnEventSchema = z.object({
  type: SttTurnEventTypeSchema,
  text: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  eagerEotConfidence: z.number().min(0).max(1).optional(),
  failureClass: ProviderFailureClassSchema.optional(),
  error: z.string().optional(),
  atMs: z.number().nonnegative().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type SttTurnEvent = z.infer<typeof SttTurnEventSchema>;

export const StreamingSttSessionOptionsSchema = z.object({
  language: z.string().optional(),
  /** Deepgram Flux-style threshold; ignored by providers that do not support it. */
  eagerEotThreshold: z.number().min(0).max(1).optional(),
  sampleRate: z.number().int().positive().optional(),
  signal: z.any().optional(),
});
export type StreamingSttSessionOptions = z.infer<typeof StreamingSttSessionOptionsSchema>;

export interface StreamingSTTSession {
  pushAudio(frame: import("./audio.js").AudioFrame): void | Promise<void>;
  events(): AsyncIterable<SttTurnEvent>;
  close(): Promise<void>;
}

export interface STTProvider {
  readonly manifest: ProviderManifest;
  healthCheck(): Promise<ProviderHealth>;
  /** Batch / simulator path. */
  transcribe(request: SttTranscribeRequest): Promise<SttResult>;
  /** Optional streaming session for voice (Flux, Scribe, etc.). */
  openSession?(options?: StreamingSttSessionOptions): Promise<StreamingSTTSession>;
}

export const TtsSynthesizeRequestSchema = z.object({
  text: z.string(),
  voiceId: z.string().optional(),
  signal: z.any().optional(),
  contextId: z.string().optional(),
  responseSegmentId: z.string().optional(),
});
export type TtsSynthesizeRequest = z.infer<typeof TtsSynthesizeRequestSchema>;

export const TtsChunkSchema = z.object({
  /** Simulated audio payload or text chunk id for the simulator. */
  chunkId: z.string(),
  text: z.string(),
  durationMs: z.number().nonnegative(),
  /** Raw PCM when available (e.g. pcm_24000). */
  pcm: z.instanceof(Uint8Array).optional(),
  sampleRate: z.number().int().positive().optional(),
});
export type TtsChunk = z.infer<typeof TtsChunkSchema>;

export const TtsDeliveryEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("audio-buffered"),
    responseSegmentId: z.string(),
    contextId: z.string(),
    audioStartMs: z.number().nonnegative(),
    audioEndMs: z.number().nonnegative(),
    pcm: z.instanceof(Uint8Array).optional(),
    sampleRate: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("word-aligned"),
    responseSegmentId: z.string(),
    contextId: z.string(),
    word: z.string(),
    characterStart: z.number().int().nonnegative(),
    characterEnd: z.number().int().nonnegative(),
    audioStartMs: z.number().nonnegative(),
    audioEndMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("playback-confirmed"),
    responseSegmentId: z.string(),
    contextId: z.string(),
    playedThroughMs: z.number().nonnegative(),
    deliveredText: z.string().optional(),
  }),
  z.object({
    type: z.literal("context-closed"),
    responseSegmentId: z.string().optional(),
    contextId: z.string(),
    reason: z.string().optional(),
  }),
]);
export type TtsDeliveryEvent = z.infer<typeof TtsDeliveryEventSchema>;

export interface MultiContextTTSSession {
  openContext(contextId: string, responseSegmentId: string): Promise<void>;
  synthesizeToContext(
    contextId: string,
    text: string,
    opts?: { flush?: boolean; signal?: AbortSignal },
  ): AsyncIterable<TtsDeliveryEvent>;
  closeContext(contextId: string, reason?: string): Promise<void>;
  close(): Promise<void>;
}

export interface TTSProvider {
  readonly manifest: ProviderManifest;
  healthCheck(): Promise<ProviderHealth>;
  /** Simple path used by M1 text simulator. */
  synthesize(request: TtsSynthesizeRequest): AsyncIterable<TtsChunk>;
  /** Optional multi-context session for interruption-aware voice. */
  openMultiContextSession?(options?: {
    voiceId?: string;
    sampleRate?: number;
  }): Promise<MultiContextTTSSession>;
}

export const UnifiedSessionRequestSchema = z.object({
  instructions: z.string().optional(),
  signal: z.any().optional(),
});
export type UnifiedSessionRequest = z.infer<typeof UnifiedSessionRequestSchema>;

/**
 * Unified realtime provider owns STT + LLM + TTS as one locked stack.
 * Vendor session objects must stay inside the adapter.
 */
export interface UnifiedRealtimeProvider {
  readonly manifest: ProviderManifest;
  healthCheck(): Promise<ProviderHealth>;
  /**
   * Process a committed user utterance end-to-end.
   * Returns assistant text stream; audio is owned by the provider in production.
   */
  respond(userText: string, request?: UnifiedSessionRequest): AsyncIterable<LlmStreamChunk>;
}
