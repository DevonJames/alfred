import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWatchedDocsFolder,
  listWatchedDocsFolders,
  removeWatchedDocsFolder,
} from "./docs-folders.js";

describe("docs-folders", () => {
  const dirs: string[] = [];
  const prevIngest = process.env.ALFRED_X_INGEST_DIR;
  const prevOip = process.env.ALFRED_MEMORY_OIP_PATH;
  const prevPersona = process.env.ALFRED_PERSONA_DIR;
  const prevProfile = process.env.ALFRED_PROFILE_ID;
  const prevKey = process.env.OPENAI_API_KEY;

  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevIngest === undefined) delete process.env.ALFRED_X_INGEST_DIR;
    else process.env.ALFRED_X_INGEST_DIR = prevIngest;
    if (prevOip === undefined) delete process.env.ALFRED_MEMORY_OIP_PATH;
    else process.env.ALFRED_MEMORY_OIP_PATH = prevOip;
    if (prevPersona === undefined) delete process.env.ALFRED_PERSONA_DIR;
    else process.env.ALFRED_PERSONA_DIR = prevPersona;
    if (prevProfile === undefined) delete process.env.ALFRED_PROFILE_ID;
    else process.env.ALFRED_PROFILE_ID = prevProfile;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("rejects a missing directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-docsui-"));
    dirs.push(root);
    process.env.ALFRED_PROFILE_ID = "p";
    process.env.ALFRED_X_INGEST_DIR = path.join(root, "ingest");
    await expect(
      addWatchedDocsFolder({ path: path.join(root, "nope"), label: "Missing", ingest: false }),
    ).rejects.toThrow(/Not a directory/);
    const docs = path.join(root, "notes");
    await mkdir(docs, { recursive: true });
    await expect(addWatchedDocsFolder({ path: docs, label: "   ", ingest: false })).rejects.toThrow(
      /Label is required/,
    );
  });

  it("adds, lists, and removes a watched folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-docsui-"));
    dirs.push(root);
    process.env.ALFRED_PROFILE_ID = "p";
    process.env.ALFRED_X_INGEST_DIR = path.join(root, "ingest");
    process.env.ALFRED_MEMORY_OIP_PATH = path.join(root, "oip");
    process.env.ALFRED_PERSONA_DIR = path.join(root, "persona");
    delete process.env.OPENAI_API_KEY;

    const docs = path.join(root, "notes");
    await mkdir(docs, { recursive: true });
    await writeFile(path.join(docs, "readme.md"), "# Hello\n\nWatched folder.\n");

    const added = await addWatchedDocsFolder({ path: docs, label: "Project notes" });
    expect(added.source.label).toBe("Project notes");
    expect(added.run?.ingested).toBe(1);

    const listed = await listWatchedDocsFolders("p");
    expect(listed.folders).toHaveLength(1);
    expect(listed.folders[0]?.label).toBe("Project notes");
    expect(listed.folders[0]?.exists).toBe(true);
    expect(listed.folders[0]?.trackedFiles).toBe(1);
    expect(listed.schedule.time).toBeTruthy();

    const removed = await removeWatchedDocsFolder(added.source.id, "p");
    expect(removed.path).toBe(path.resolve(docs));
    expect((await listWatchedDocsFolders("p")).folders).toEqual([]);
  });
});
