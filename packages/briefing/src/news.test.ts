import { describe, expect, it } from "vitest";
import {
  extractArticleTextFromHtml,
  extractiveArticleSummary,
  matchNewsHeadline,
  type NewsHeadline,
} from "./news.js";

describe("matchNewsHeadline", () => {
  const headlines: NewsHeadline[] = [
    { title: "Markets rally after Fed decision", source: "AP News", url: "https://example.com/a" },
    { title: "Storms hit the Gulf Coast", source: "BBC News", url: "https://example.com/b" },
    { title: "Tech stocks slip in afternoon trading", source: "TechCrunch" },
  ];

  it("matches by 1-based index", () => {
    expect(matchNewsHeadline(headlines, { index: 2 })?.title).toMatch(/Storms/);
  });

  it("matches by title fragment", () => {
    expect(matchNewsHeadline(headlines, { match: "Fed decision" })?.source).toBe("AP News");
  });

  it("returns null when nothing matches", () => {
    expect(matchNewsHeadline(headlines, { match: "moon landing" })).toBeNull();
  });
});

describe("article extract", () => {
  it("pulls paragraph text from html", () => {
    const html = `
      <html><body><article>
        <p>Short</p>
        <p>This is a longer paragraph that should be kept for the article body summary.</p>
        <p>Another substantial paragraph with enough characters to survive the filter.</p>
      </article></body></html>`;
    const text = extractArticleTextFromHtml(html);
    expect(text).toMatch(/longer paragraph/);
    expect(text).toMatch(/Another substantial/);
  });

  it("builds a short extractive summary", () => {
    const body =
      "First sentence about the story that goes on long enough. " +
      "Second sentence adds more detail for the listener. " +
      "Third sentence wraps the point cleanly.";
    const spoken = extractiveArticleSummary(body, "Markets rally");
    expect(spoken).toMatch(/About "Markets rally"/);
    expect(spoken).toMatch(/First sentence/);
  });
});
