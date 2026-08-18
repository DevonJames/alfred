import { describe, expect, it } from "vitest";
import { formatXIngestSpeech } from "./x-ingest.js";

describe("formatXIngestSpeech", () => {
  it("summarizes a single ingest and lists many", () => {
    const one = formatXIngestSpeech({
      dayKey: "2026-08-17",
      updatedAt: "2026-08-17T12:00:00.000Z",
      items: [
        {
          url: "https://x.com/i/status/1",
          canonicalUrl: "https://x.com/i/status/1",
          noteName: "Marketing",
          headline: "Notes on the engine",
          author: "Ada",
          status: "ingested",
          summary: "The analytical engine weaves algebraic patterns.",
        },
      ],
    });
    expect(one).toMatch(/Marketing note/);
    expect(one).toMatch(/analytical engine/);

    const many = formatXIngestSpeech({
      dayKey: "2026-08-17",
      updatedAt: "2026-08-17T12:00:00.000Z",
      items: [
        {
          url: "u1",
          canonicalUrl: "u1",
          headline: "Alpha",
          status: "ingested",
        },
        {
          url: "u2",
          canonicalUrl: "u2",
          headline: "Beta",
          status: "ingested",
        },
        {
          url: "u3",
          canonicalUrl: "u3",
          headline: "Secret memo",
          status: "failed",
          error: "a paywall",
        },
      ],
    });
    expect(many).toMatch(/I saved 2 items/);
    expect(many).toMatch(/Secret memo could not be ingested because of a paywall/);
  });
});
