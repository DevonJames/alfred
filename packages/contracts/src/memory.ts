import { z } from "zod";

export const MemoryCapabilitySchema = z.enum([
  "retrieve",
  "commit_turn",
  "inspect",
  "edit",
  "delete",
  "import_canonical",
  "export_canonical",
  "episodic",
  "editable_blocks",
  "temporal_graph",
  "vector_retrieval",
  "file_backed",
]);
export type MemoryCapability = z.infer<typeof MemoryCapabilitySchema>;

export const MemoryProviderManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().default("0.1.0"),
  capabilities: z.array(MemoryCapabilitySchema),
});
export type MemoryProviderManifest = z.infer<typeof MemoryProviderManifestSchema>;

export const MemoryQuerySchema = z.object({
  text: z.string(),
  limit: z.number().int().positive().default(8),
  sessionId: z.string().optional(),
  profileId: z.string().optional(),
});
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

export const NormalizedMemoryItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  sourceId: z.string(),
  providerId: z.string(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  confidence: z.number().min(0).max(1).optional(),
  relevance: z.number().min(0).max(1).optional(),
  provenance: z.record(z.unknown()).default({}),
});
export type NormalizedMemoryItem = z.infer<typeof NormalizedMemoryItemSchema>;

export const MemoryRetrievalResultSchema = z.object({
  items: z.array(NormalizedMemoryItemSchema),
  providerId: z.string(),
  retrievedAt: z.string().datetime(),
});
export type MemoryRetrievalResult = z.infer<typeof MemoryRetrievalResultSchema>;

export const MemoryTurnCommitSchema = z.object({
  profileId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  metadata: z.record(z.unknown()).default({}),
});
export type MemoryTurnCommit = z.infer<typeof MemoryTurnCommitSchema>;

export const CanonicalMemoryRecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CanonicalMemoryRecord = z.infer<typeof CanonicalMemoryRecordSchema>;

export interface MemoryProvider {
  readonly manifest: MemoryProviderManifest;
  retrieve(query: MemoryQuery): Promise<MemoryRetrievalResult>;
  commitTurn(commit: MemoryTurnCommit): Promise<void>;
  inspect?(limit?: number): Promise<NormalizedMemoryItem[]>;
  edit?(id: string, content: string): Promise<void>;
  delete?(id: string): Promise<void>;
  exportCanonical?(): Promise<CanonicalMemoryRecord[]>;
  importCanonical?(records: CanonicalMemoryRecord[]): Promise<void>;
}
