import { z } from "zod";

/**
 * Preferred machine-readable knowledge export for Alfred ingest.
 * Markdown exports still work via the legacy section splitter.
 */

export const ConfidenceSchema = z.enum(["explicit", "supported", "tentative", "superseded"]);
export type ExportConfidence = z.infer<typeof ConfidenceSchema>;

export const UserPatchSchema = z.object({
  highPriorityPersistentContext: z.string().min(1),
  howToWorkEffectivelyWithMe: z.string().min(1),
  negativePreferences: z.string().optional(),
});

export const ExportEntitySchema = z.object({
  tempId: z.string().min(1),
  schemaType: z
    .string()
    .default("https://schema.org/Thing")
    .describe("schema.org URL, e.g. https://schema.org/Person"),
  entityClass: z
    .string()
    .default("Thing")
    .describe("Person | Place | Organization | Product | Project | …"),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().optional(),
  confidence: ConfidenceSchema.default("explicit"),
  relationships: z
    .array(
      z.object({
        predicate: z.string().min(1),
        objectTempId: z.string().min(1),
      }),
    )
    .default([]),
});

export const ExportAssertionSchema = z.object({
  tempId: z.string().min(1),
  subjectTempId: z.string().min(1),
  predicate: z.string().min(1),
  objectTempId: z.string().optional(),
  objectText: z.string().optional(),
  summary: z.string().min(1),
  confidence: ConfidenceSchema.default("explicit"),
  validFrom: z.string().nullable().optional(),
  validUntil: z.string().nullable().optional(),
  learnedAt: z.string().optional(),
  topics: z.array(z.string()).default([]),
});

export const ExportEpisodeSchema = z.object({
  tempId: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  participantTempIds: z.array(z.string()).default([]),
  locationTempId: z.string().optional(),
  involvedTempIds: z.array(z.string()).default([]),
  start: z.string().optional(),
  end: z.string().optional(),
  confidence: ConfidenceSchema.default("explicit"),
});

export const ExportMemorySchema = z.object({
  tempId: z.string().min(1),
  kind: z
    .enum([
      "fact",
      "note",
      "preference",
      "project",
      "open_loop",
      "timeline",
      "technical",
      "business",
      "creative",
    ])
    .default("note"),
  title: z.string().min(1),
  text: z.string().min(1),
  confidence: ConfidenceSchema.default("explicit"),
  topics: z.array(z.string()).default([]),
  relatedTempIds: z.array(z.string()).default([]),
  validFrom: z.string().nullable().optional(),
  validUntil: z.string().nullable().optional(),
  staleRisk: z.boolean().default(false),
});

export const KnowledgeExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().optional(),
  source: z.string().optional(),
  subjectName: z.string().optional(),
  userPatch: UserPatchSchema,
  entities: z.array(ExportEntitySchema).default([]),
  episodes: z.array(ExportEpisodeSchema).default([]),
  assertions: z.array(ExportAssertionSchema).default([]),
  memories: z.array(ExportMemorySchema).default([]),
  potentiallyStale: z.array(z.string()).default([]),
  knowledgeGaps: z.array(z.string()).default([]),
});

export type KnowledgeExport = z.infer<typeof KnowledgeExportSchema>;

/** Detect whether text looks like a v1 knowledge-export JSON document. */
export function tryParseKnowledgeExportJson(text: string): KnowledgeExport | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = KnowledgeExportSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
