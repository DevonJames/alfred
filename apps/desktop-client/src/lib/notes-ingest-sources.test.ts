import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addNotesIngestSource,
  listNotesIngestSources,
  removeNotesIngestSource,
} from "./notes-ingest-sources.js";

describe("notes-ingest-sources", () => {
  const dirs: string[] = [];
  const prevIngest = process.env.ALFRED_X_INGEST_DIR;
  const prevProfile = process.env.ALFRED_PROFILE_ID;

  afterEach(async () => {
    if (prevIngest === undefined) delete process.env.ALFRED_X_INGEST_DIR;
    else process.env.ALFRED_X_INGEST_DIR = prevIngest;
    if (prevProfile === undefined) delete process.env.ALFRED_PROFILE_ID;
    else process.env.ALFRED_PROFILE_ID = prevProfile;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("lists, adds, and removes Apple Notes inboxes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-notesui-"));
    dirs.push(root);
    process.env.ALFRED_PROFILE_ID = "p";
    process.env.ALFRED_X_INGEST_DIR = path.join(root, "ingest");

    expect((await listNotesIngestSources("p")).sources).toEqual([]);

    const added = await addNotesIngestSource({
      folder: "USPTO",
      note: "uspto job prep",
      profileId: "p",
    });
    expect(added.source.note).toBe("uspto job prep");
    expect(added.source.archiveNote).toBe("uspto job prep Ingested");
    expect(added.sources).toHaveLength(1);
    expect(added.sources[0]?.folder).toBe("USPTO");
    expect(added.schedule.label).toMatch(/daily at /);

    const listed = await listNotesIngestSources("p");
    expect(listed.sources[0]?.note).toBe("uspto job prep");
    expect(listed.sources[0]?.trackedLinks).toBe(0);

    const removed = await removeNotesIngestSource(added.source.id, "p");
    expect(removed.removed.note).toBe("uspto job prep");
    expect((await listNotesIngestSources("p")).sources).toEqual([]);
  });

  it("rejects blank folder or note titles", async () => {
    await expect(addNotesIngestSource({ folder: "  ", note: "Prep" })).rejects.toThrow(/folder/i);
    await expect(addNotesIngestSource({ folder: "USPTO", note: "" })).rejects.toThrow(/Note title/);
  });
});
