import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OipLocalMemoryProvider, type YtDlpRunner } from "@alfred/memory";
import { afterEach, describe, expect, it } from "vitest";
import { ingestYouTubeLink, youtubeLinkError } from "./youtube-ingest.js";

const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("youtube ingest link", () => {
  const dirs: string[] = [];
  const prevIngest = process.env.ALFRED_X_INGEST_DIR;
  const prevBriefing = process.env.BRIEFING_CACHE_DIR;

  afterEach(async () => {
    if (prevIngest === undefined) delete process.env.ALFRED_X_INGEST_DIR;
    else process.env.ALFRED_X_INGEST_DIR = prevIngest;
    if (prevBriefing === undefined) delete process.env.BRIEFING_CACHE_DIR;
    else process.env.BRIEFING_CACHE_DIR = prevBriefing;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("accepts a watch or short link and rejects playlists", () => {
    expect(youtubeLinkError(WATCH)).toBeUndefined();
    expect(youtubeLinkError("https://youtu.be/dQw4w9WgXcQ")).toBeUndefined();
    expect(youtubeLinkError("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBeUndefined();
    expect(youtubeLinkError("")).toMatch(/Paste a YouTube link/);
    expect(youtubeLinkError("https://example.com/watch?v=dQw4w9WgXcQ")).toMatch(/youtube\.com or youtu\.be/);
    expect(youtubeLinkError("https://www.youtube.com/playlist?list=PLxxxx")).toMatch(/Playlists/);
    expect(youtubeLinkError("https://www.youtube.com/@acme")).toMatch(/channel pages/);
  });

  it("stores the full caption transcript in memory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-ytpage-"));
    dirs.push(dir);
    process.env.ALFRED_X_INGEST_DIR = path.join(dir, "ingest");
    process.env.BRIEFING_CACHE_DIR = path.join(dir, "briefing");

    const transcript = "Retention holds the loop together across the whole talk.";
    const runner: YtDlpRunner = async (args, opts) => {
      if (args.includes("-J")) {
        return {
          stdout: JSON.stringify({
            id: "dQw4w9WgXcQ",
            title: "Growth loops",
            description: "A marketing primer.",
            channel: "Acme Channel",
            upload_date: "20260801",
            duration: 125,
            subtitles: { en: [{ ext: "vtt" }] },
          }),
          stderr: "",
        };
      }
      if (args.includes("--write-subs") && opts?.cwd) {
        await writeFile(
          path.join(opts.cwd, "dQw4w9WgXcQ.en.vtt"),
          `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${transcript}\n`,
        );
      }
      return { stdout: "", stderr: "" };
    };

    const provider = new OipLocalMemoryProvider(path.join(dir, "oip"));
    const result = await ingestYouTubeLink("https://youtu.be/dQw4w9WgXcQ?si=tracking", {
      profileId: "p",
      provider,
      runner,
    });

    expect(result.status).toBe("ingested");
    expect(result.kind).toBe("video");
    expect(result.headline).toBe("Growth loops");
    expect(result.author).toBe("Acme Channel");
    expect(result.transcript).toBe(transcript);
    expect(result.summary).toContain(transcript);

    const hit = await provider.retrieve({
      text: "YouTube video growth loops retention",
      limit: 8,
    });
    const memory = hit.items.map((i) => i.content).join("\n");
    expect(memory).toContain(transcript);
    expect(memory).toContain("Title: Growth loops");
    expect(memory).toContain("Description:\nA marketing primer.");
    expect(memory).toContain("Published: 2026-08-01");
    expect(memory).toMatch(/source=YouTube/);
  });
});
