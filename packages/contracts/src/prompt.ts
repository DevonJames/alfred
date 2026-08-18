import { z } from "zod";
import { LlmMessageSchema } from "./providers.js";
import { NormalizedMemoryItemSchema } from "./memory.js";
import { AgentDelegationResultSchema } from "./agents.js";

export const PromptModeSchema = z.enum([
  "initial",
  "addendum",
  "continuation",
  "correction",
  "replacement",
  "clarification",
]);
export type PromptMode = z.infer<typeof PromptModeSchema>;

export const PersonaContextSchema = z.object({
  soul: z.string().optional(),
  identity: z.string().optional(),
  user: z.string().optional(),
  dir: z.string().optional(),
});
export type PersonaContext = z.infer<typeof PersonaContextSchema>;

export const PromptAssemblyInputSchema = z.object({
  systemInstructions: z.string(),
  currentUserTurn: z.string(),
  recentConversation: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      text: z.string(),
    }),
  ),
  /** OpenClaw-style always-on bootstrap: SOUL / IDENTITY / USER markdown. */
  personaContext: PersonaContextSchema.optional(),
  retrievedMemory: z.array(NormalizedMemoryItemSchema).default([]),
  existingResponseState: z
    .object({
      spokenText: z.string().default(""),
      unspokenText: z.string().default(""),
      proposedText: z.string().default(""),
      isGenerating: z.boolean().default(false),
      isSpeaking: z.boolean().default(false),
    })
    .optional(),
  lateAddenda: z.array(z.string()).default([]),
  interruptionState: z
    .object({
      interrupted: z.boolean(),
      userInterruptionText: z.string().optional(),
      arbitrationOutcome: z.string().optional(),
    })
    .optional(),
  agentResults: z.array(AgentDelegationResultSchema).default([]),
  availableCapabilities: z.array(z.string()).default(["delegate_task"]),
  /** Due briefing reminders the model may complete/dismiss/snooze via update_reminder. */
  dueReminders: z
    .array(
      z.object({
        recordId: z.string(),
        summary: z.string(),
        remindAt: z.string().nullable().optional(),
        status: z.string().nullable().optional(),
      }),
    )
    .optional(),
  mode: PromptModeSchema.default("initial"),
});
export type PromptAssemblyInput = z.infer<typeof PromptAssemblyInputSchema>;

export const AssembledPromptSchema = z.object({
  mode: PromptModeSchema,
  messages: z.array(LlmMessageSchema),
  notes: z.array(z.string()).default([]),
});
export type AssembledPrompt = z.infer<typeof AssembledPromptSchema>;
