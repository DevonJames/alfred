import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  joinChunkTranscripts,
  probeAudioDurationSeconds,
  resolveFfmpeg,
  shouldChunkAudio,
  splitAudioForStt,
} from "./audio-chunks.js";

const execFileAsync = promisify(execFile);

describe("audio note chunking", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("chunks long or large files, not short ones", () => {
    expect(shouldChunkAudio({ byteLength: 1_000_000, durationSeconds: 120 })).toBe(false);
    expect(shouldChunkAudio({ byteLength: 1_000_000, durationSeconds: 20 * 60 })).toBe(true);
    expect(shouldChunkAudio({ byteLength: 25 * 1024 * 1024, durationSeconds: 60 })).toBe(true);
    expect(shouldChunkAudio({ byteLength: 1000, durationSeconds: 30, force: true })).toBe(true);
  });

  it("joins chunk transcripts with blank lines", () => {
    expect(joinChunkTranscripts(["  hello ", "", "world"])).toBe("hello\n\nworld");
  });

  it("splits a generated clip into 5-second wav segments", async () => {
    const ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) return;

    const dir = await mkdtemp(path.join(tmpdir(), "alfred-chunk-src-"));
    dirs.push(dir);
    const source = path.join(dir, "twelve.wav");
    await execFileAsync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=12",
      "-ac",
      "1",
      "-ar",
      "16000",
      source,
    ]);
    const bytes = await readFile(source);
    const duration = await probeAudioDurationSeconds(bytes, "twelve.wav");
    expect(duration).toBeGreaterThan(11);
    expect(duration).toBeLessThan(13);

    const split = await splitAudioForStt({
      bytes,
      filename: "twelve.wav",
      segmentSeconds: 5,
      force: true,
    });
    expect(split.usedFfmpeg).toBe(true);
    expect(split.chunks.length).toBeGreaterThanOrEqual(3);
    expect(split.chunks[0]?.mimeType).toBe("audio/wav");
    expect(split.chunks[0]?.bytes.length).toBeGreaterThan(1000);
  }, 30_000);
});
