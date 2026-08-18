import { describe, expect, it } from "vitest";
import { looksLikeXIngest, parseLearnedAtWindow, parseXIngestIntent } from "./intent.js";

describe("x-ingest intent", () => {
  it("detects a pull-this-link request", () => {
    const intent = parseXIngestIntent("go pull this X link https://x.com/foo/status/99");
    expect(intent).toEqual({ kind: "url", url: "https://x.com/foo/status/99" });
  });

  it("detects batch inbox ingest", () => {
    expect(parseXIngestIntent("ingest my X notes")).toEqual({ kind: "notes", note: undefined });
    expect(parseXIngestIntent("ingest my marketing note", ["Marketing"])).toEqual({
      kind: "notes",
      note: "Marketing",
    });
  });

  it("parses last-week as learnedAt unless published is named", () => {
    const now = new Date("2026-08-17T20:00:00.000Z");
    const learned = parseLearnedAtWindow("from my marketing note last week", now);
    expect(learned?.field).toBe("learnedAt");
    const published = parseLearnedAtWindow("article posted last week", now);
    expect(published?.field).toBe("published");
    expect(looksLikeXIngest("save this twitter thread https://twitter.com/a/status/1")).toBe(true);
  });

  it("detects a YouTube pull-this-link request", () => {
    expect(parseXIngestIntent("go pull this YouTube link https://youtu.be/dQw4w9WgXcQ")).toEqual({
      kind: "url",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
  });
});
