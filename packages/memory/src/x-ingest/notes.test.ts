import { describe, expect, it } from "vitest";
import {
  annotateFailureInNoteBody,
  appendArchiveLine,
  extractInboxUrls,
  removeUrlFromNoteBody,
} from "./notes.js";

describe("x-ingest notes body helpers", () => {
  const url = "https://x.com/foo/status/1";

  it("extracts inbox URLs and drains them", () => {
    const body = `<div>${url}</div><div>https://x.com/bar/status/2</div>`;
    expect(extractInboxUrls(body)).toHaveLength(2);
    const next = removeUrlFromNoteBody(body, url);
    expect(next).not.toContain(url);
    expect(next).toContain("https://x.com/bar/status/2");
  });

  it("annotates failures and appends archive lines", () => {
    const failed = annotateFailureInNoteBody(url, url, "paywall");
    expect(failed).toContain("— failed: paywall");
    const archived = appendArchiveLine("", {
      date: "2026-08-17",
      author: "Ada",
      headline: "Hello",
      url,
    });
    expect(archived).toContain("Ada");
    expect(archived).toContain("Hello");
  });
});
