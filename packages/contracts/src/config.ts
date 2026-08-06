import { z } from "zod";
import { AgentRoutingRuleSchema } from "./agents.js";
import { PipelineConfigurationSchema } from "./pipeline.js";
import { ProviderConfigSchema, ProviderPriorityListSchema } from "./providers.js";

export const UserProfileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  activeMemoryProviderId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const UserConfigurationSchema = z.object({
  profile: UserProfileSchema,
  providerConfigs: z.array(ProviderConfigSchema).default([]),
  pipeline: PipelineConfigurationSchema,
  /** Cascaded modality lists mirrored for convenience / persistence. */
  priorityLists: z.array(ProviderPriorityListSchema).default([]),
  agentRouting: z.array(AgentRoutingRuleSchema).default([]),
  systemInstructions: z
    .string()
    .default("You are ALFRED, a helpful conversational assistant. Be concise and accurate."),
});
export type UserConfiguration = z.infer<typeof UserConfigurationSchema>;
