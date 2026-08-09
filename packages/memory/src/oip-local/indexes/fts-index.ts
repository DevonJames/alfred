/**
 * FTS helpers — lexical search is implemented inside SqliteMemoryIndex (FTS5).
 * This module exists as the LexicalIndex adapter surface for future swap-outs.
 */
import type { SqliteMemoryIndex } from "./sqlite-index.js";

export interface LexicalHit {
  recordId: string;
  score: number;
}

export class FtsIndex {
  constructor(private readonly sqlite: SqliteMemoryIndex) {}

  search(query: string, limit = 20): LexicalHit[] {
    return this.sqlite.searchFts(query, limit).map((r) => ({
      recordId: r.record_id,
      // bm25: lower is better in SQLite — invert for fusion
      score: 1 / (1 + Math.max(0, r.rank)),
    }));
  }
}
