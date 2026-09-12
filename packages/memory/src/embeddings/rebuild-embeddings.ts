/**
 * Rebuild memory embeddings (OpenAI) + PCA projection for Graph (beta).
 */

import {
  buildEmbedText,
  embeddingModelFromEnv,
  openaiEmbedTexts,
  requireOpenAiApiKey,
} from "./openai-embeddings.js";
import { FileVectorIndex, type VectorManifest } from "../oip-local/indexes/file-vector-index.js";

export interface EmbedRecordInput {
  id: string;
  revision: string;
  name: string | null;
  searchText: string | null;
}

export interface EmbeddingRebuildProgress {
  phase: "embed" | "project" | "write";
  label: string;
  current: number;
  total: number;
  percent: number;
}

export interface EmbeddingRebuildResult {
  manifest: VectorManifest;
  embedded: number;
}

export async function rebuildOpenAiEmbeddings(opts: {
  rootDir: string;
  records: EmbedRecordInput[];
  onProgress?: (p: EmbeddingRebuildProgress) => void | Promise<void>;
}): Promise<EmbeddingRebuildResult> {
  requireOpenAiApiKey();
  const model = embeddingModelFromEnv();
  const store = new FileVectorIndex(opts.rootDir);
  const total = opts.records.length;

  await opts.onProgress?.({
    phase: "embed",
    label: total ? `Embedding 0/${total}` : "No records to embed",
    current: 0,
    total,
    percent: 0,
  });

  const texts = opts.records.map((r) => buildEmbedText(r.name, r.searchText));
  const embeddings = await openaiEmbedTexts(texts, {
    model,
    onProgress: async (p) => {
      // Reserve ~0–85% for API embed, 85–100% for project/write
      const percent = Math.round(p.percent * 0.85);
      await opts.onProgress?.({
        phase: "embed",
        label: p.label,
        current: p.current,
        total: p.total,
        percent,
      });
    },
  });

  await opts.onProgress?.({
    phase: "project",
    label: "Projecting to 3D (PCA)…",
    current: total,
    total: Math.max(1, total),
    percent: 88,
  });

  await store.rebuild(
    opts.records.map((r, i) => ({
      recordId: r.id,
      revision: r.revision,
      text: texts[i]!,
      embedding: embeddings[i]!,
    })),
  );

  await opts.onProgress?.({
    phase: "write",
    label: "Writing vector index…",
    current: total,
    total: Math.max(1, total),
    percent: 94,
  });

  const manifest = await store.writeStore({
    provider: "openai",
    model,
  });

  await opts.onProgress?.({
    phase: "write",
    label: "Done",
    current: total,
    total: Math.max(1, total),
    percent: 100,
  });

  return { manifest, embedded: total };
}
