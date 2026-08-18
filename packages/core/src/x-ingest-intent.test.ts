import { describe, expect, it } from "vitest";
import { looksLikeXIngestTask } from "./x-ingest-intent.js";

describe("looksLikeXIngestTask", () => {
  it("matches X URLs and ingest phrasing", () => {
    expect(looksLikeXIngestTask("go pull this X link https://x.com/a/status/1")).toBe(true);
    expect(looksLikeXIngestTask("ingest my X notes")).toBe(true);
    expect(looksLikeXIngestTask("go pull this YouTube link https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(looksLikeXIngestTask("what's the weather")).toBe(false);
  });
});
