import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureYouTubeVideo, vttToPlainText, YtDlpMissingError, type YtDlpRunner } from "./youtube-capture.js";

const VIDEO_ID = "dQw4w9WgXcQ";
const WATCH = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const SAMPLE_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
Growth loops compound <c>when retention</c> holds.

00:00:02.000 --> 00:00:04.000
Growth loops compound when retention holds.
`;

function dumpJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: VIDEO_ID,
    title: "Growth loops",
    description: "A marketing primer on compounding acquisition.",
    channel: "Acme Channel",
    upload_date: "20260801",
    duration: 125,
    subtitles: { en: [{ ext: "vtt" }] },
    ...overrides,
  });
}

describe("youtube-capture", () => {
  it("parses VTT to plain text without timestamps or tags", () => {
    expect(vttToPlainText(SAMPLE_VTT)).toBe("Growth loops compound when retention holds.");
  });

  it("fails playlists without calling yt-dlp", async () => {
    let called = 0;
    const runner: YtDlpRunner = async () => {
      called += 1;
      return { stdout: "", stderr: "" };
    };
    const capture = await captureYouTubeVideo("https://www.youtube.com/playlist?list=PLxxxx", {
      runner,
    });
    expect(called).toBe(0);
    expect(capture.failure?.reason).toBe("playlist not supported");
  });

  it("captures metadata plus transcript from a fake yt-dlp runner", async () => {
    const runner: YtDlpRunner = async (args, opts) => {
      if (args.includes("-J")) return { stdout: dumpJson(), stderr: "" };
      if (args.includes("--write-subs") && opts?.cwd) {
        await mkdir(opts.cwd, { recursive: true });
        await writeFile(path.join(opts.cwd, `${VIDEO_ID}.en.vtt`), SAMPLE_VTT);
      }
      return { stdout: "", stderr: "" };
    };
    const capture = await captureYouTubeVideo(`https://youtu.be/${VIDEO_ID}?si=zz`, { runner });
    expect(capture.failure).toBeUndefined();
    expect(capture.kind).toBe("video");
    expect(capture.canonicalUrl).toBe(WATCH);
    expect(capture.headline).toBe("Growth loops");
    expect(capture.author).toBe("Acme Channel");
    expect(capture.description).toMatch(/marketing primer/);
    expect(capture.text).toMatch(/retention holds/);
    expect(capture.videoId).toBe(VIDEO_ID);
    expect(capture.publishedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("fails when captions are missing", async () => {
    const runner: YtDlpRunner = async (args) => {
      if (args.includes("-J")) {
        return {
          stdout: dumpJson({ subtitles: {}, automatic_captions: {} }),
          stderr: "",
        };
      }
      throw new Error("should not write subs");
    };
    const capture = await captureYouTubeVideo(WATCH, { runner });
    expect(capture.failure?.reason).toBe("no transcript");
    expect(capture.headline).toBe("Growth loops");
  });

  it("fails clearly when yt-dlp is missing", async () => {
    const runner: YtDlpRunner = async () => {
      throw new YtDlpMissingError();
    };
    const capture = await captureYouTubeVideo(WATCH, { runner });
    expect(capture.failure?.reason).toMatch(/yt-dlp not installed/);
    expect(capture.failure?.reason).toMatch(/brew install yt-dlp/);
  });
});
