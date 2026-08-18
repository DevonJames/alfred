import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addXSource, findXSource, loadXSources, removeXSource } from "./sources.js";

describe("x-ingest sources", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    delete process.env.ALFRED_X_INGEST_DIR;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("adds, lists, and removes notes by folder+title", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-xsrc-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = dir;
    const added = await addXSource("t", { folder: "Alfred", note: "Marketing" });
    expect(added.id).toBe("marketing");
    expect(added.archiveNote).toBe("Marketing Ingested");
    const sources = await loadXSources("t");
    expect(findXSource(sources, "marketing")?.note).toBe("Marketing");
    const removed = await removeXSource("t", "Marketing");
    expect(removed?.note).toBe("Marketing");
    expect(await loadXSources("t")).toEqual([]);
  });
});
