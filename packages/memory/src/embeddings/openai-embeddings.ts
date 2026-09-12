/**
 * OpenAI Embeddings API client (fetch-based, no openai SDK dependency).
 */

import { createHash } from "node:crypto";
import { openaiApiKey } from "../photo-analyze.js";

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

export function embeddingModelFromEnv(): string {
  return process.env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;
}

export function requireOpenAiApiKey(): string {
  const key = openaiApiKey();
  if (!key) {
    throw new Error("OPENAI_API_KEY is required to build memory embeddings");
  }
  return key;
}

export function hashEmbedText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildEmbedText(
  name: string | null | undefined,
  searchText: string | null | undefined,
): string {
  return `${name ?? ""} ${searchText ?? ""}`.trim().replace(/\s+/g, " ");
}

export interface EmbedBatchProgress {
  phase: "embed";
  label: string;
  current: number;
  total: number;
  percent: number;
}

/**
 * Embed texts via OpenAI /v1/embeddings. Batches up to `batchSize` inputs per request.
 */
export async function openaiEmbedTexts(
  texts: string[],
  opts?: {
    apiKey?: string;
    model?: string;
    batchSize?: number;
    onProgress?: (p: EmbedBatchProgress) => void | Promise<void>;
  },
): Promise<number[][]> {
  const apiKey = opts?.apiKey ?? requireOpenAiApiKey();
  const model = opts?.model ?? embeddingModelFromEnv();
  const batchSize = Math.max(1, Math.min(opts?.batchSize ?? 128, 2048));
  const out: number[][] = new Array(texts.length);
  const total = texts.length;

  for (let start = 0; start < texts.length; start += batchSize) {
    const slice = texts.slice(start, start + batchSize);
    const input = slice.map((t) => (t.trim() ? t.slice(0, 30_000) : "."));

    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI embeddings failed (${res.status}): ${body.slice(0, 400)}`);
    }

    const json = (await res.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    const rows = json.data ?? [];
    if (rows.length !== input.length) {
      throw new Error(
        `OpenAI embeddings returned ${rows.length} vectors for ${input.length} inputs`,
      );
    }
    for (const row of rows) {
      out[start + row.index] = row.embedding;
    }

    const current = Math.min(start + slice.length, total);
    const percent = total === 0 ? 100 : Math.round((current / total) * 100);
    await opts?.onProgress?.({
      phase: "embed",
      label: `Embedding ${current}/${total}`,
      current,
      total,
      percent,
    });
  }

  return out;
}
