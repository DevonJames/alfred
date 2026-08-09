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

/** Unwrap markdown-link schemaTypes from chat UIs: [https://…](https://…) */
export function normalizeSchemaType(raw: string | undefined): string {
  if (!raw?.trim()) return "https://schema.org/Thing";
  const md = /^\[([^\]]+)\]\([^)]+\)$/.exec(raw.trim());
  if (md?.[1]) return md[1].trim();
  // Also handle accidental "URL](URL" leftovers
  const url = raw.match(/https?:\/\/schema\.org\/[A-Za-z0-9]+/);
  if (url) return url[0];
  return raw.trim();
}

export const ExportEntitySchema = z.object({
  tempId: z.string().min(1),
  schemaType: z
    .string()
    .default("https://schema.org/Thing")
    .transform(normalizeSchemaType)
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

/** Known kinds; unknown strings (e.g. "career") are kept as-is. */
export const ExportMemorySchema = z.object({
  tempId: z.string().min(1),
  kind: z.string().min(1).default("note"),
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

export type KnowledgeExportParseResult =
  | { ok: true; data: KnowledgeExport }
  | { ok: false; reason: "not_json" | "invalid_json" | "schema"; issues: string[] };

/** Detect whether text looks like a v1 knowledge-export JSON document. */
export function parseKnowledgeExportJson(text: string): KnowledgeExportParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return { ok: false, reason: "not_json", issues: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      reason: "invalid_json",
      issues: [e instanceof Error ? e.message : String(e)],
    };
  }
  const result = KnowledgeExportSchema.safeParse(parsed);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    reason: "schema",
    issues: result.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    ),
  };
}

/** @deprecated prefer parseKnowledgeExportJson */
export function tryParseKnowledgeExportJson(text: string): KnowledgeExport | null {
  const r = parseKnowledgeExportJson(text);
  return r.ok ? r.data : null;
}

export function looksLikeKnowledgeExportJson(text: string, filename?: string): boolean {
  if (filename && /\.json$/i.test(filename)) return true;
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    return obj?.version === 1 && typeof obj.userPatch === "object" && obj.userPatch !== null;
  } catch {
    return false;
  }
}
