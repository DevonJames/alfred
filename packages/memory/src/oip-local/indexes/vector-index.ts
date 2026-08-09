/**
 * Pluggable vector index — stub for Phase 0–1.
 * Embeddings remain optional and rebuildable; not required for acceptance tests.
 */

export interface VectorHit {
  recordId: string;
  score: number;
}

export interface VectorIndex {
  upsert(recordId: string, revision: string, text: string, embedding: number[]): Promise<void>;
  search(queryEmbedding: number[], limit: number): Promise<VectorHit[]>;
  rebuild(records: Array<{ recordId: string; revision: string; text: string; embedding: number[] }>): Promise<void>;
  clear(): Promise<void>;
}

export class NoopVectorIndex implements VectorIndex {
  async upsert(): Promise<void> {}
  async search(): Promise<VectorHit[]> {
    return [];
  }
  async rebuild(): Promise<void> {}
  async clear(): Promise<void> {}
}
