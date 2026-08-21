import { describe, expect, it } from "vitest";
import { looksLikeDocsIngest, parseDocsIngestIntent } from "./intent.js";
import { looksLikeXIngest } from "../x-ingest/intent.js";

describe("docs-ingest intent", () => {
  it("parses run, labeled run, add path, and list", () => {
    expect(parseDocsIngestIntent("ingest my docs")).toEqual({ kind: "run", source: undefined });
    expect(parseDocsIngestIntent("update the Alfred docs folder", ["Alfred docs"])).toEqual({
      kind: "run",
      source: "Alfred docs",
    });
    expect(
      parseDocsIngestIntent("watch /Users/devon/Documents/development/alfred/docs"),
    ).toEqual({
      kind: "add",
      path: "/Users/devon/Documents/development/alfred/docs",
      label: undefined,
    });
    expect(parseDocsIngestIntent("list documentation folders")).toEqual({ kind: "list" });
  });

  it("does not collide with X notes ingest", () => {
    expect(looksLikeDocsIngest("ingest my X notes")).toBe(false);
    expect(looksLikeXIngest("ingest my docs")).toBe(false);
    expect(looksLikeDocsIngest("ingest my docs")).toBe(true);
  });
});
