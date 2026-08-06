import { describe, expect, it } from "vitest";
import { SentenceAwareTtsChunker } from "./tts-chunker.js";

describe("SentenceAwareTtsChunker", () => {
  it("flushes on sentence terminator", () => {
    const c = new SentenceAwareTtsChunker();
    const a = c.push("Hello there. ");
    expect(a.some((f) => f.reason === "sentence")).toBe(true);
    expect(a[0]?.text).toContain("Hello there.");
  });

  it("buffers until word budget when no punctuation", () => {
    const c = new SentenceAwareTtsChunker({ minWords: 4, maxWords: 6 });
    const words = "one two three four five six seven ";
    const flushes = c.push(words);
    expect(flushes.length).toBeGreaterThan(0);
    expect(flushes[0]?.reason).toBe("word_budget");
  });

  it("flushRemaining forces leftover text", () => {
    const c = new SentenceAwareTtsChunker();
    c.push("Almost done");
    const last = c.flushRemaining();
    expect(last?.text).toContain("Almost done");
    expect(last?.reason).toBe("forced");
  });
});
