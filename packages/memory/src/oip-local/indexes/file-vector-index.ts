/**
 * File-backed vector index under `{oipRoot}/indexes/vectors/`.
 * Stores embeddings + a cached 3D PCA projection for Graph (beta).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashEmbedText } from "../../embeddings/openai-embeddings.js";
import type { PcaProjection3d } from "../pca.js";
import { projectEmbeddingsPca } from "../pca.js";
import type { VectorHit, VectorIndex } from "./vector-index.js";

export const VECTORS_DIR_NAME = "vectors";

export interface VectorManifest {
  provider: "openai" | "local" | string;
  model: string;
  dimensions: number;
  recordCount: number;
  builtAt: string;
  layoutScale: number;
  projectionMethod: "pca";
}

export interface StoredVectorRow {
  id: string;
  revision: string;
  textHash: string;
  embedding: number[];
}

export interface EmbeddingSpaceSnapshot {
  root: string;
  manifest: VectorManifest | null;
  positions: Record<string, { x: number; y: number; z: number }>;
  stale: boolean;
  missing: boolean;
  generatedAt: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-12 ? 0 : dot / denom;
}

export class FileVectorIndex implements VectorIndex {
  private rows = new Map<string, StoredVectorRow>();
  private projection: PcaProjection3d | null = null;
  private manifest: VectorManifest | null = null;
  private loaded = false;

  constructor(readonly rootDir: string) {}

  get dir(): string {
    return path.join(this.rootDir, "indexes", VECTORS_DIR_NAME);
  }

  private manifestPath(): string {
    return path.join(this.dir, "manifest.json");
  }

  private vectorsPath(): string {
    return path.join(this.dir, "vectors.jsonl");
  }

  private projectionPath(): string {
    return path.join(this.dir, "projection.json");
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.rows.clear();
    this.projection = null;
    this.manifest = null;
    try {
      const raw = await readFile(this.manifestPath(), "utf8");
      this.manifest = JSON.parse(raw) as VectorManifest;
    } catch {
      return;
    }
    try {
      const text = await readFile(this.vectorsPath(), "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const row = JSON.parse(trimmed) as StoredVectorRow;
        if (row?.id && Array.isArray(row.embedding)) this.rows.set(row.id, row);
      }
    } catch {
      /* missing vectors file */
    }
    try {
      const proj = JSON.parse(await readFile(this.projectionPath(), "utf8")) as PcaProjection3d;
      if (proj?.positions) this.projection = proj;
    } catch {
      /* missing projection */
    }
  }

  getManifest(): VectorManifest | null {
    return this.manifest;
  }

  getProjection(): PcaProjection3d | null {
    return this.projection;
  }

  listIds(): string[] {
    return [...this.rows.keys()];
  }

  /** Return stored embeddings for the given ids (skips missing). */
  async getEmbeddings(
    ids?: string[],
  ): Promise<Array<{ id: string; embedding: number[] }>> {
    await this.ensureLoaded();
    const wanted = ids?.length ? ids : [...this.rows.keys()];
    const out: Array<{ id: string; embedding: number[] }> = [];
    for (const id of wanted) {
      const row = this.rows.get(id);
      if (row?.embedding?.length) out.push({ id, embedding: row.embedding });
    }
    return out;
  }

  async upsert(
    recordId: string,
    revision: string,
    text: string,
    embedding: number[],
  ): Promise<void> {
    await this.ensureLoaded();
    this.rows.set(recordId, {
      id: recordId,
      revision,
      textHash: hashEmbedText(text),
      embedding,
    });
  }

  async search(queryEmbedding: number[], limit: number): Promise<VectorHit[]> {
    await this.ensureLoaded();
    const scored: VectorHit[] = [];
    for (const row of this.rows.values()) {
      scored.push({ recordId: row.id, score: cosine(queryEmbedding, row.embedding) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, limit));
  }

  async rebuild(
    records: Array<{ recordId: string; revision: string; text: string; embedding: number[] }>,
  ): Promise<void> {
    this.rows.clear();
    for (const r of records) {
      this.rows.set(r.recordId, {
        id: r.recordId,
        revision: r.revision,
        textHash: hashEmbedText(r.text),
        embedding: r.embedding,
      });
    }
    this.loaded = true;
  }

  async clear(): Promise<void> {
    this.rows.clear();
    this.projection = null;
    this.manifest = null;
    this.loaded = true;
    await rm(this.dir, { recursive: true, force: true });
  }

  async writeStore(opts: {
    provider: string;
    model: string;
    layoutScale?: number;
  }): Promise<VectorManifest> {
    await mkdir(this.dir, { recursive: true });
    const ids: string[] = [];
    const vectors: number[][] = [];
    const lines: string[] = [];
    for (const row of this.rows.values()) {
      ids.push(row.id);
      vectors.push(row.embedding);
      lines.push(JSON.stringify(row));
    }
    const dimensions = vectors[0]?.length ?? 0;
    const layoutScale = opts.layoutScale ?? 420;
    this.projection = projectEmbeddingsPca(ids, vectors, layoutScale);
    const manifest: VectorManifest = {
      provider: opts.provider,
      model: opts.model,
      dimensions,
      recordCount: ids.length,
      builtAt: new Date().toISOString(),
      layoutScale,
      projectionMethod: "pca",
    };
    this.manifest = manifest;
    await writeFile(this.vectorsPath(), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
    await writeFile(this.projectionPath(), `${JSON.stringify(this.projection)}\n`, "utf8");
    await writeFile(this.manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    this.loaded = true;
    return manifest;
  }

  async snapshot(expectedIds?: Set<string>): Promise<EmbeddingSpaceSnapshot> {
    await this.ensureLoaded();
    const positions = this.projection?.positions ?? {};
    let stale = false;
    if (expectedIds && this.manifest) {
      let overlap = 0;
      for (const id of expectedIds) {
        if (positions[id]) overlap++;
      }
      const coverage = expectedIds.size === 0 ? 1 : overlap / expectedIds.size;
      stale =
        coverage < 0.85 ||
        Math.abs(this.manifest.recordCount - expectedIds.size) > expectedIds.size * 0.2;
    } else if (!this.manifest) {
      stale = true;
    }
    return {
      root: this.rootDir,
      manifest: this.manifest,
      positions,
      stale: Boolean(this.manifest) && stale,
      missing: !this.manifest || Object.keys(positions).length === 0,
      generatedAt: new Date().toISOString(),
    };
  }
}
