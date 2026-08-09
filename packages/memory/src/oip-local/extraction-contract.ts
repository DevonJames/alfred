import { z } from "zod";

/**
 * Structured LLM extraction output contract (schema only — no LLM wiring yet).
 * Freeform model prose must never become canonical memory directly.
 */
export const MemoryExtractionResultSchema = z.object({
  entities: z.array(z.record(z.unknown())).default([]),
  episodes: z.array(z.record(z.unknown())).default([]),
  observations: z.array(z.record(z.unknown())).default([]),
  assertions: z.array(z.record(z.unknown())).default([]),
  relationships: z.array(z.record(z.unknown())).default([]),
  temporalReferences: z.array(z.record(z.unknown())).default([]),
  scheduledSurfacing: z
    .object({
      remindAt: z.string().nullable().optional(),
      reminderTimezone: z.string().nullable().optional(),
      reminderStatus: z.string().nullable().optional(),
      reminderRecurrence: z.string().nullable().optional(),
      reminderReason: z.string().nullable().optional(),
    })
    .default({}),
  publicKnowledge: z
    .object({
      isPublicSource: z.boolean().default(false),
      canonicalPublicObjectId: z.string().nullable().optional(),
      publicationEligible: z.boolean().default(false),
      recommendedPublicRecordType: z.string().nullable().optional(),
    })
    .default({}),
  memoryImportance: z.number().min(0).max(1).optional(),
  ambiguities: z.array(z.record(z.unknown())).default([]),
  needsResolution: z.array(z.record(z.unknown())).default([]),
});

export type MemoryExtractionResult = z.infer<typeof MemoryExtractionResultSchema>;
