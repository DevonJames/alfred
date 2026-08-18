import { describe, expect, it } from "vitest";
import { canonicalizeXUrl, extractXUrls, isXUrl, slugFromTitle } from "./urls.js";

describe("x-ingest urls", () => {
  it("extracts x.com and twitter.com links from HTML", () => {
    const html = `<div>see <a href="https://x.com/foo/status/1234567890?s=20">post</a> and https://twitter.com/bar/status/99</div>`;
    expect(extractXUrls(html)).toEqual([
      "https://x.com/foo/status/1234567890?s=20",
      "https://twitter.com/bar/status/99",
    ]);
  });

  it("canonicalizes status URLs and strips tracking", () => {
    expect(canonicalizeXUrl("https://twitter.com/foo/status/1234567890?s=20&t=abc")).toBe(
      "https://x.com/i/status/1234567890",
    );
    expect(canonicalizeXUrl("https://www.x.com/i/article/abc123")).toBe(
      "https://x.com/i/article/abc123",
    );
  });

  it("detects X URLs", () => {
    expect(isXUrl("https://x.com/foo/status/1")).toBe(true);
    expect(isXUrl("https://example.com/x")).toBe(false);
  });

  it("slugs note titles", () => {
    expect(slugFromTitle("Marketing X")).toBe("marketing-x");
  });
});
