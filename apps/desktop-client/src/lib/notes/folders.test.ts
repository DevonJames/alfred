import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { walkAudioNoteFiles } from "./folders.js";

describe("walkAudioNoteFiles", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("finds audio files and skips other types", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alfred-voicenotes-"));
    dirs.push(root);
    await writeFile(path.join(root, "Home 14.m4a"), "a");
    await writeFile(path.join(root, "Sunset Plaza.mp3"), "b");
    await writeFile(path.join(root, "notes.txt"), "nope");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "Sarah Chen.wav"), "c");

    const files = await walkAudioNoteFiles(root);
    expect(files.map((f) => f.relPath).sort()).toEqual([
      "Home 14.m4a",
      "Sunset Plaza.mp3",
      "nested/Sarah Chen.wav",
    ]);
  });
});
