import { describe, expect, it } from "vitest";
import { looksLikeDocsIngestTask } from "./docs-ingest-intent.js";
import { looksLikeXIngestTask } from "./x-ingest-intent.js";

describe("looksLikeDocsIngestTask", () => {
  it("matches docs folder phrasing and not X notes", () => {
    expect(looksLikeDocsIngestTask("ingest my docs")).toBe(true);
    expect(looksLikeDocsIngestTask("update the Alfred docs folder")).toBe(true);
    expect(looksLikeDocsIngestTask("watch /Users/devon/docs")).toBe(true);
    expect(looksLikeDocsIngestTask("watch /Users/devon/docs documentation folder")).toBe(true);
    expect(looksLikeDocsIngestTask("ingest my X notes")).toBe(false);
    expect(looksLikeXIngestTask("ingest my docs")).toBe(false);
    expect(looksLikeDocsIngestTask("what's the weather")).toBe(false);
  });
});
