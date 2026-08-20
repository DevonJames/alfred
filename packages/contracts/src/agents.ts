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
  "household",
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
  "household",
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

export const DELEGATE_TASK_TOOL = {
  name: "delegate_task",
  description:
    "Delegate an external action such as ingesting X.com links from Apple Notes or fetching a single X URL into memory.",
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: [
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
        ],
      },
      taskDescription: { type: "string" },
    },
    required: ["category", "taskDescription"],
  },
} as const;

/**
 * Complete, dismiss, or snooze a due briefing reminder from conversation.
 * Call on casual completion language — not only explicit "clear reminder".
 */
export const UPDATE_REMINDER_TOOL = {
  name: "update_reminder",
  description:
    "Update a due daily-briefing reminder when the user indicates it is done, no longer needed, already handled, or should be snoozed/rescheduled. " +
    "Call this for casual phrasing too (e.g. 'I took care of X yesterday', 'already done', 'you can stop reminding me', 'thanks for the reminder' when clearly about a due item). " +
    "Use action=completed when finished, dismissed when they want it dropped without completing, snoozed when they want it later (requires snoozedUntil). " +
    "Prefer recordId from the due-reminders list when known; otherwise pass match text describing which reminder.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["completed", "dismissed", "snoozed"],
      },
      match: {
        type: "string",
        description: "Free-text description of which reminder when recordId is unknown",
      },
      recordId: {
        type: "string",
        description: "Exact memory record id from the due-reminders list when known",
      },
      snoozedUntil: {
        type: "string",
        description: "ISO timestamp or YYYY-MM-DD when action is snoozed",
      },
    },
    required: ["action"],
  },
} as const;

export const AgentRoutingRuleSchema = z.object({
  category: TaskCategorySchema,
  orderedHarnessIds: z.array(z.string().min(1)).min(1),
});
export type AgentRoutingRule = z.infer<typeof AgentRoutingRuleSchema>;
