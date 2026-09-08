import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 5-minute segments — same as alfred-home, and each 16 kHz mono WAV stays under OpenAI's 25 MB cap. */
export const AUDIO_STT_CHUNK_SECONDS = 5 * 60;
const OPENAI_SAFE_BYTES = 20 * 1024 * 1024;
const WHOLE_FILE_MAX_SECONDS = 8 * 60;

export interface AudioSttChunk {
  index: number;
  bytes: Buffer;
  filename: string;
  mimeType: string;
  startSeconds: number;
}

export interface SplitAudioResult {
  chunks: AudioSttChunk[];
  durationSeconds: number | null;
  usedFfmpeg: boolean;
}

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  "ffmpeg",
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].filter((p): p is string => Boolean(p?.trim()));

const FFPROBE_CANDIDATES = [
  process.env.FFPROBE_PATH,
  "ffprobe",
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
  "/usr/bin/ffprobe",
].filter((p): p is string => Boolean(p?.trim()));

let resolvedFfmpeg: string | null | undefined;
let resolvedFfprobe: string | null | undefined;

async function firstExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate === "ffmpeg" || candidate === "ffprobe") {
      try {
        await execFileAsync(candidate, ["-version"], { timeout: 5000 });
        return candidate;
      } catch {
        continue;
      }
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function resolveFfmpeg(): Promise<string | null> {
  if (resolvedFfmpeg !== undefined) return resolvedFfmpeg;
  resolvedFfmpeg = await firstExecutable(FFMPEG_CANDIDATES);
  return resolvedFfmpeg;
}

export async function resolveFfprobe(): Promise<string | null> {
  if (resolvedFfprobe !== undefined) return resolvedFfprobe;
  resolvedFfprobe = await firstExecutable(FFPROBE_CANDIDATES);
  return resolvedFfprobe;
}

export function shouldChunkAudio(opts: {
  byteLength: number;
  durationSeconds?: number | null;
  force?: boolean;
}): boolean {
  if (opts.force) return true;
  if (opts.byteLength > OPENAI_SAFE_BYTES) return true;
  if (opts.durationSeconds != null && opts.durationSeconds > WHOLE_FILE_MAX_SECONDS) return true;
  return false;
}

export function joinChunkTranscripts(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

function inputExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if ([".m4a", ".mp4", ".mp3", ".wav", ".webm", ".ogg", ".flac", ".aac", ".caf"].includes(ext)) {
    return ext;
  }
  return ".m4a";
}

export async function probeAudioDurationSeconds(
  bytes: Buffer,
  filename: string,
): Promise<number | null> {
  const ffprobe = await resolveFfprobe();
  if (!ffprobe) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "alfred-probe-"));
  const inputPath = path.join(dir, `input${inputExtension(filename)}`);
  try {
    await writeFile(inputPath, bytes);
    const { stdout } = await execFileAsync(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath],
      { timeout: 30_000 },
    );
    const value = Number.parseFloat(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function splitAudioForStt(opts: {
  bytes: Buffer;
  filename: string;
  segmentSeconds?: number;
  force?: boolean;
}): Promise<SplitAudioResult> {
  const durationSeconds = await probeAudioDurationSeconds(opts.bytes, opts.filename);
  const segmentSeconds = opts.segmentSeconds ?? AUDIO_STT_CHUNK_SECONDS;
  if (
    !shouldChunkAudio({
      byteLength: opts.bytes.length,
      durationSeconds,
      force: opts.force,
    })
  ) {
    return {
      chunks: [
        {
          index: 0,
          bytes: opts.bytes,
          filename: opts.filename,
          mimeType: "application/octet-stream",
          startSeconds: 0,
        },
      ],
      durationSeconds,
      usedFfmpeg: false,
    };
  }

  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    console.warn("[notes] ffmpeg not found; transcribing the whole file");
    return {
      chunks: [
        {
          index: 0,
          bytes: opts.bytes,
          filename: opts.filename,
          mimeType: "application/octet-stream",
          startSeconds: 0,
        },
      ],
      durationSeconds,
      usedFfmpeg: false,
    };
  }

  const dir = await mkdtemp(path.join(tmpdir(), "alfred-stt-"));
  const inputPath = path.join(dir, `input${inputExtension(opts.filename)}`);
  const outputPattern = path.join(dir, "segment_%03d.wav");
  try {
    await writeFile(inputPath, opts.bytes);
    await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "segment",
        "-segment_time",
        String(segmentSeconds),
        "-c",
        "pcm_s16le",
        outputPattern,
      ],
      { timeout: 30 * 60 * 1000 },
    );
    const names = (await readdir(dir))
      .filter((name) => name.startsWith("segment_") && name.endsWith(".wav"))
      .sort();
    if (names.length === 0) {
      throw new Error("ffmpeg produced no audio chunks");
    }
    const chunks: AudioSttChunk[] = [];
    for (const [index, name] of names.entries()) {
      chunks.push({
        index,
        bytes: await readFile(path.join(dir, name)),
        filename: name,
        mimeType: "audio/wav",
        startSeconds: index * segmentSeconds,
      });
    }
    return { chunks, durationSeconds, usedFfmpeg: true };
  } catch (err) {
    console.warn("[notes] ffmpeg chunking failed; using the whole file:", err);
    return {
      chunks: [
        {
          index: 0,
          bytes: opts.bytes,
          filename: opts.filename,
          mimeType: "application/octet-stream",
          startSeconds: 0,
        },
      ],
      durationSeconds,
      usedFfmpeg: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
