import { z } from "zod";
import { FailoverSettingsSchema, ProviderPriorityListSchema } from "./providers.js";

export const PipelineModeSchema = z.enum(["cascaded", "unified"]);
export type PipelineMode = z.infer<typeof PipelineModeSchema>;

export const PipelineConfigurationSchema = z.object({
  mode: PipelineModeSchema,
  /** Used when mode=cascaded. */
  sttPriority: ProviderPriorityListSchema.optional(),
  llmPriority: ProviderPriorityListSchema.optional(),
  ttsPriority: ProviderPriorityListSchema.optional(),
  /** Used when mode=unified. */
  unifiedPriority: ProviderPriorityListSchema.optional(),
  /** Allow failover from unified stack to cascaded components. Default false. */
  allowCascadedFallback: z.boolean().default(false),
  unifiedFailoverSettings: FailoverSettingsSchema.optional(),
});
export type PipelineConfiguration = z.infer<typeof PipelineConfigurationSchema>;

export const SelectorLockReasonSchema = z.object({
  selector: z.enum(["stt", "llm", "tts"]),
  locked: z.boolean(),
  reasonCode: z.enum(["unified_mode_active", "cascaded_mode_active", "not_applicable"]),
  message: z.string(),
  unifiedProviderId: z.string().optional(),
  unifiedStackId: z.string().optional(),
});
export type SelectorLockReason = z.infer<typeof SelectorLockReasonSchema>;

export const PipelineValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()).default([]),
  locks: z.array(SelectorLockReasonSchema).default([]),
});
export type PipelineValidationResult = z.infer<typeof PipelineValidationResultSchema>;
