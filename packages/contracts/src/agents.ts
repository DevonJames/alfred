import { z } from "zod";
import { PermissionScopeSchema } from "./secrets.js";

export const AgentCapabilitySchema = z.enum([
  "email",
  "calendar",
  "coding",
  "repository",
  "filesystem",
  "shell",
  "browser",
  "research",
  "computer_use",
  "messaging",
  "general",
]);
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const TaskCategorySchema = z.enum([
  "email",
  "calendar",
  "coding",
  "repository",
  "filesystem",
  "shell",
  "browser",
  "research",
  "computer_use",
  "general",
]);
export type TaskCategory = z.infer<typeof TaskCategorySchema>;

export const AgentHarnessManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().default("0.1.0"),
  capabilities: z.array(AgentCapabilitySchema),
  notes: z.string().optional(),
});
export type AgentHarnessManifest = z.infer<typeof AgentHarnessManifestSchema>;

export const AgentDelegationRequestSchema = z.object({
  correlationId: z.string(),
  taskDescription: z.string().min(1),
  taskCategory: TaskCategorySchema,
  conversationContext: z.string().default(""),
  permissions: z.array(PermissionScopeSchema).default(["agent.delegate"]),
  requestedOutputFormat: z.enum(["text", "json", "markdown"]).default("text"),
  confirmationRequired: z.boolean().default(false),
  deadlineMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().default(60_000),
});
export type AgentDelegationRequest = z.infer<typeof AgentDelegationRequestSchema>;

export const AgentDelegationResultSchema = z.object({
  correlationId: z.string(),
  harnessId: z.string(),
  status: z.enum(["completed", "failed", "needs_confirmation", "cancelled"]),
  output: z.string().default(""),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type AgentDelegationResult = z.infer<typeof AgentDelegationResultSchema>;

export interface AgentHarness {
  readonly manifest: AgentHarnessManifest;
  supports(category: TaskCategory): boolean;
  execute(request: AgentDelegationRequest): Promise<AgentDelegationResult>;
}

export const AgentRoutingRuleSchema = z.object({
  category: TaskCategorySchema,
  orderedHarnessIds: z.array(z.string().min(1)).min(1),
});
export type AgentRoutingRule = z.infer<typeof AgentRoutingRuleSchema>;
