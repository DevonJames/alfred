/**
 * Accumulates LLM tokens into speakable fragments for TTS flush.
 * Flush on complete short sentences, strong punctuation, or ~8–16 words when needed.
 * Continue buffering incomplete proper names, numbers/dates, unclosed quotes.
 */
export interface ChunkerFlush {
  text: string;
  reason: "sentence" | "punctuation" | "word_budget" | "forced";
}

export class SentenceAwareTtsChunker {
  private buffer = "";
  private readonly minWords: number;
  private readonly maxWords: number;

  constructor(opts?: { minWords?: number; maxWords?: number }) {
    this.minWords = opts?.minWords ?? 8;
    this.maxWords = opts?.maxWords ?? 16;
  }

  push(token: string): ChunkerFlush[] {
    this.buffer += token;
    const flushes: ChunkerFlush[] = [];
    while (true) {
      const flush = this.tryFlush(false);
      if (!flush) break;
      flushes.push(flush);
    }
    return flushes;
  }

  flushRemaining(): ChunkerFlush | undefined {
    return this.tryFlush(true);
  }

  peek(): string {
    return this.buffer;
  }

  private tryFlush(forced: boolean): ChunkerFlush | undefined {
    const text = this.buffer;
    if (!text.trim()) {
      if (forced) this.buffer = "";
      return undefined;
    }

    if (this.hasUnclosedQuote(text) || this.endsWithIncompleteAtom(text)) {
      if (!forced) return undefined;
    }

    const sentenceMatch = text.match(/^[\s\S]*?[.!?…](?:["')\]]*)(?:\s+|$)/);
    if (sentenceMatch && !this.endsWithIncompleteAtom(sentenceMatch[0]!)) {
      const chunk = sentenceMatch[0]!;
      this.buffer = text.slice(chunk.length);
      return { text: chunk, reason: "sentence" };
    }

    const clauseMatch = text.match(/^[\s\S]*?[,;:](?:\s+|$)/);
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (
      clauseMatch &&
      words.length >= this.minWords &&
      !this.endsWithIncompleteAtom(clauseMatch[0]!)
    ) {
      const chunk = clauseMatch[0]!;
      this.buffer = text.slice(chunk.length);
      return { text: chunk, reason: "punctuation" };
    }

    if (words.length >= this.maxWords) {
      // Flush up to last complete word boundary within budget.
      const cut = text.lastIndexOf(" ");
      if (cut > 0) {
        const chunk = text.slice(0, cut + 1);
        this.buffer = text.slice(cut + 1);
        return { text: chunk, reason: "word_budget" };
      }
    }

    if (forced && text.trim()) {
      this.buffer = "";
      return { text, reason: "forced" };
    }
    return undefined;
  }

  private hasUnclosedQuote(text: string): boolean {
    const doubles = (text.match(/"/g) ?? []).length;
    return doubles % 2 === 1;
  }

  private endsWithIncompleteAtom(text: string): boolean {
    const trimmed = text.trimEnd();
    // Trailing number/date-like or capitalized token without terminator.
    if (/\d([.,:/-]\d*)?$/.test(trimmed)) return true;
    if (/[A-Z][a-z]+$/.test(trimmed) && !/[.!?]$/.test(trimmed)) {
      // Possible incomplete proper name — only block if no sentence end yet.
      const words = trimmed.split(/\s+/);
      const last = words[words.length - 1] ?? "";
      if (last.length <= 2) return true;
    }
    return false;
  }
}
