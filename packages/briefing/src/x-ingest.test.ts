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

  it("caps a long ingest list instead of reading every headline", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      url: `u${i}`,
      canonicalUrl: `u${i}`,
      noteName: "uspto job prep",
      headline: `Headline ${i}`,
      status: "ingested" as const,
    }));
    const speech = formatXIngestSpeech({
      dayKey: "2026-08-18",
      updatedAt: "2026-08-18T12:00:00.000Z",
      items,
    });
    expect(speech).toMatch(/I saved 12 items from X from your uspto job prep note/);
    expect(speech).toMatch(/Headline 0/);
    expect(speech).toMatch(/and 8 more/);
    expect(speech).not.toMatch(/Headline 11/);
  });

  it("names YouTube videos in failure speech", () => {
    const speech = formatXIngestSpeech({
      dayKey: "2026-08-17",
      updatedAt: "2026-08-17T12:00:00.000Z",
      items: [
        {
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          headline: "Growth loops",
          kind: "video",
          status: "failed",
          error: "no transcript",
        },
      ],
    });
    expect(speech).toBe(
      "The YouTube video titled Growth loops could not be ingested because of no transcript.",
    );
  });
});
