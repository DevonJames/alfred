import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { XCapture } from "./types.js";
import {
  canonicalizeYouTubeUrl,
  isYouTubePlaylistOrChannelUrl,
  youtubeVideoIdFromUrl,
} from "./urls.js";

const execFileAsync = promisify(execFile);

const YTDLP_MISSING =
  "yt-dlp not installed (brew install yt-dlp, or set ALFRED_YTDLP_PATH)";

export type YtDlpRunner = (
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export class YtDlpMissingError extends Error {
  constructor() {
    super(YTDLP_MISSING);
    this.name = "YtDlpMissingError";
  }
}

export function ytDlpBinary(): string {
  return process.env.ALFRED_YTDLP_PATH?.trim() || "yt-dlp";
}

export async function defaultYtDlpRunner(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const bin = ytDlpBinary();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
      cwd: opts?.cwd,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") throw new YtDlpMissingError();
    const stderr = String(e.stderr ?? e.message ?? "");
    const stdout = String(e.stdout ?? "");
    throw Object.assign(new Error(stderr || e.message || "yt-dlp failed"), { stdout, stderr });
  }
}

interface YtCaptionTrack {
  ext?: string;
  url?: string;
}

interface YtDump {
  _type?: string;
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  channel?: string;
  channel_id?: string;
  upload_date?: string;
  duration?: number;
  availability?: string;
  age_limit?: number;
  subtitles?: Record<string, YtCaptionTrack[] | undefined>;
  automatic_captions?: Record<string, YtCaptionTrack[] | undefined>;
}

const PREFERRED_LANGS = ["en", "en-US", "en-GB", "en-orig"];

export function vttToPlainText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT" || line.startsWith("WEBVTT ")) continue;
    if (line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("KIND:")) continue;
    if (/^\d+$/.test(line)) continue;
    if (/-->/.test(line)) continue;
    const cleaned = line.replace(/<\/?[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    if (!cleaned) continue;
    if (cleaned === lines[lines.length - 1]) continue;
    lines.push(cleaned);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function captionLangs(info: YtDump): string[] {
  const keys = new Set<string>();
  for (const map of [info.subtitles, info.automatic_captions]) {
    if (!map) continue;
    for (const k of Object.keys(map)) {
      if (map[k]?.length) keys.add(k);
    }
  }
  return [...keys];
}

function pickCaptionLang(langs: string[]): string | undefined {
  for (const pref of PREFERRED_LANGS) {
    const hit = langs.find((l) => l === pref || l.toLowerCase().startsWith(pref.toLowerCase()));
    if (hit) return hit;
  }
  return langs.find((l) => l.toLowerCase().startsWith("en")) ?? langs[0];
}

function uploadDateToIso(uploadDate?: string): string | undefined {
  if (!uploadDate || !/^\d{8}$/.test(uploadDate)) return undefined;
  const y = uploadDate.slice(0, 4);
  const m = uploadDate.slice(4, 6);
  const d = uploadDate.slice(6, 8);
  return `${y}-${m}-${d}T00:00:00.000Z`;
}

export function isoDuration(seconds?: number): string | undefined {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `PT${h}H${m}M${r}S`;
  if (m) return `PT${m}M${r}S`;
  return `PT${r}S`;
}

function mapDumpFailure(info: YtDump): string | undefined {
  if (info._type === "playlist") return "playlist not supported";
  const avail = (info.availability ?? "").toLowerCase();
  if (avail === "private" || avail === "premium" || avail === "subscriber_only" || avail === "needs_auth") {
    return "private or members-only";
  }
  if ((info.age_limit ?? 0) >= 18) return "age-gate";
  return undefined;
}

function mapYtDlpMessage(message: string): string {
  const t = message.toLowerCase();
  if (t.includes("private") || t.includes("members-only") || t.includes("members only")) {
    return "private or members-only";
  }
  if (t.includes("sign in to confirm your age") || t.includes("age-restricted") || t.includes("age restricted")) {
    return "age-gate";
  }
  if (t.includes("playlist")) return "playlist not supported";
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "yt-dlp failed";
}

async function readBestVtt(dir: string, preferredLang?: string): Promise<string | undefined> {
  const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".vtt"));
  if (!names.length) return undefined;
  const ranked = names.sort((a, b) => {
    const score = (n: string) => {
      const lower = n.toLowerCase();
      if (preferredLang && lower.includes(`.${preferredLang.toLowerCase()}.`)) return 0;
      if (lower.includes(".en-orig.")) return 1;
      if (lower.includes(".en-us.")) return 2;
      if (lower.includes(".en.")) return 3;
      if (/\.en[-.]/.test(lower)) return 4;
      return 10;
    };
    return score(a) - score(b);
  });
  const chosen = ranked[0];
  if (!chosen) return undefined;
  return readFile(path.join(dir, chosen), "utf8");
}

function emptyCapture(url: string, canonicalUrl: string, failure: string, headline?: string): XCapture {
  return {
    url,
    canonicalUrl,
    kind: "video",
    author: "",
    headline: headline ?? "",
    text: "",
    posts: [],
    outboundUrls: [],
    screenshots: [],
    images: [],
    failure: { reason: failure, headline },
  };
}

export async function captureYouTubeVideo(
  url: string,
  opts?: { runner?: YtDlpRunner },
): Promise<XCapture> {
  const canonicalUrl = canonicalizeYouTubeUrl(url);
  if (isYouTubePlaylistOrChannelUrl(url) || !youtubeVideoIdFromUrl(url)) {
    return emptyCapture(url, canonicalUrl, "playlist not supported");
  }

  const runner = opts?.runner ?? defaultYtDlpRunner;
  let dumpRaw: { stdout: string; stderr: string };
  try {
    dumpRaw = await runner(["-J", "--no-download", "--no-warnings", "--no-playlist", url]);
  } catch (err) {
    if (err instanceof YtDlpMissingError) {
      return emptyCapture(url, canonicalUrl, YTDLP_MISSING);
    }
    return emptyCapture(url, canonicalUrl, mapYtDlpMessage(err instanceof Error ? err.message : String(err)));
  }

  let info: YtDump;
  try {
    info = JSON.parse(dumpRaw.stdout) as YtDump;
  } catch {
    return emptyCapture(url, canonicalUrl, mapYtDlpMessage(dumpRaw.stderr || "yt-dlp returned invalid JSON"));
  }

  const dumpFail = mapDumpFailure(info);
  if (dumpFail) {
    return emptyCapture(url, canonicalUrl, dumpFail, info.title);
  }

  const langs = captionLangs(info);
  const lang = pickCaptionLang(langs);
  if (!lang) {
    return emptyCapture(url, canonicalUrl, "no transcript", info.title);
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "alfred-ytdlp-"));
  try {
    await runner(
      [
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        `${lang},en.*,en`,
        "--sub-format",
        "vtt",
        "-o",
        "%(id)s",
        url,
      ],
      { cwd: tmp },
    );
    const vtt = await readBestVtt(tmp, lang);
    const transcript = vtt ? vttToPlainText(vtt) : "";
    if (!transcript) {
      return emptyCapture(url, canonicalUrl, "no transcript", info.title);
    }

    const author = info.channel || info.uploader || "";
    const videoId = info.id || youtubeVideoIdFromUrl(url);
    const publishedAt = uploadDateToIso(info.upload_date);
    return {
      url,
      canonicalUrl,
      kind: "video",
      author,
      authorHandle: info.channel_id,
      publishedAt,
      headline: info.title || canonicalUrl,
      text: transcript,
      description: info.description || undefined,
      durationSeconds: typeof info.duration === "number" ? info.duration : undefined,
      videoId,
      posts: [
        {
          text: transcript,
          author,
          publishedAt,
          url: canonicalUrl,
        },
      ],
      outboundUrls: [],
      screenshots: [],
      images: [],
    };
  } catch (err) {
    if (err instanceof YtDlpMissingError) {
      return emptyCapture(url, canonicalUrl, YTDLP_MISSING, info.title);
    }
    return emptyCapture(
      url,
      canonicalUrl,
      mapYtDlpMessage(err instanceof Error ? err.message : String(err)),
      info.title,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
