import { z } from "zod";

export const MemoryRecordTypeSchema = z.enum([
  "Entity",
  "Episode",
  "Assertion",
  "Observation",
  "Artifact",
]);
export type MemoryRecordType = z.infer<typeof MemoryRecordTypeSchema>;

export const ProvenanceSchema = z
  .object({
    source: z.string().optional(),
    sourceType: z.string().optional(),
    speaker: z.string().optional(),
    author: z.string().optional(),
    learnedAt: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    extractionMethod: z.string().optional(),
    model: z.string().optional(),
    modelVersion: z.string().optional(),
    sourceRevision: z.string().optional(),
  })
  .passthrough();

export const AlfredMetaSchema = z
  .object({
    entityClass: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    confidenceLabel: z
      .enum(["confirmed", "high", "medium", "low", "inferred"])
      .optional(),
    visibility: z.enum(["private", "shared", "public"]).optional(),
    owner: z.string().optional(),
    assertionType: z.enum(["explicit", "inferred", "extracted"]).optional(),
  })
  .passthrough();

export const MemoryRevisionSchema = z
  .object({
    id: z.string().startsWith("did:memory:"),
    type: MemoryRecordTypeSchema,
    revision: z.string(),
    previousRevision: z.string().nullable(),
    schemaType: z.string().optional(),
    schema: z.record(z.unknown()).default({}),
    alfred: AlfredMetaSchema.default({}),
    drefs: z.record(z.unknown()).default({}),
    createdAt: z.string(),
    updatedAt: z.string(),
    learnedAt: z.string().optional(),
    validFrom: z.string().nullable().optional(),
    validUntil: z.string().nullable().optional(),
    provenance: ProvenanceSchema.default({}),
    // Type-specific convenience fields (also mirrored into schema/drefs as needed)
    subject: z.string().optional(),
    predicate: z.string().optional(),
    object: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    text: z.string().optional(),
    name: z.string().optional(),
    participants: z.array(z.string()).optional(),
    location: z.string().optional(),
    validTimeStart: z.string().optional(),
    validTimeEnd: z.string().optional(),
    speaker: z.string().optional(),
    observedAt: z.string().optional(),
    sourceArtifact: z.string().optional(),
    contentHash: z.string().optional(),
    mimeType: z.string().optional(),
    byteSize: z.number().int().nonnegative().optional(),
    originalFilename: z.string().optional(),
    storedAt: z.string().optional(),
    ingestedAt: z.string().optional(),
    supersedes: z.array(z.string()).optional(),
    contradicts: z.array(z.string()).optional(),
    reinforces: z.array(z.string()).optional(),
    remindAt: z.string().nullable().optional(),
    reminderStatus: z.string().optional(),
    reminderReason: z.string().optional(),
    reminderTimezone: z.string().optional(),
    reminderLastSurfacedAt: z.string().nullable().optional(),
    reminderSnoozedUntil: z.string().nullable().optional(),
    reminderCompletedAt: z.string().nullable().optional(),
  })
  .passthrough();

export type MemoryRevision = z.infer<typeof MemoryRevisionSchema>;

export const PackageManifestSchema = z.object({
  id: z.string().startsWith("did:memory:"),
  type: MemoryRecordTypeSchema,
  currentRevision: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export const StorageFormatSchema = z.object({
  version: z.number().int().positive(),
  hashAlgorithm: z.literal("sha256"),
  createdAt: z.string(),
  description: z.string().optional(),
});
export type StorageFormat = z.infer<typeof StorageFormatSchema>;

export const STORAGE_FORMAT_VERSION = 1;
