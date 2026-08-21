import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDocsSource, findDocsSource, loadDocsSources, removeDocsSource } from "./sources.js";

describe("docs-ingest sources", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    delete process.env.ALFRED_X_INGEST_DIR;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("adds, lists, and removes folders by path or label", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-docsrc-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = dir;
    const added = await addDocsSource("t", { path: "/tmp/alfred-docs", label: "Alfred docs" });
    expect(added.id).toBe("alfred-docs");
    expect(added.label).toBe("Alfred docs");
    const sources = await loadDocsSources("t");
    expect(findDocsSource(sources, "alfred docs")?.path).toBe(path.resolve("/tmp/alfred-docs"));
    const removed = await removeDocsSource("t", "Alfred docs");
    expect(removed?.label).toBe("Alfred docs");
    expect(await loadDocsSources("t")).toEqual([]);
  });
});
