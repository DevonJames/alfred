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
    if (/^(NOTE|STYLE|KIND|LANGUAGE|REGION)\b/i.test(line)) continue;
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

const CAPTION_EXT_RANK: Record<string, number> = { vtt: 0, srt: 1, json3: 2, srv3: 3, ttml: 4 };

function bestUrlTrack(tracks: YtCaptionTrack[] | undefined): YtCaptionTrack | undefined {
  const withUrl = (tracks ?? []).filter((track) => track.url);
  withUrl.sort(
    (a, b) =>
      (CAPTION_EXT_RANK[(a.ext ?? "").toLowerCase()] ?? 9) -
      (CAPTION_EXT_RANK[(b.ext ?? "").toLowerCase()] ?? 9),
  );
  return withUrl[0];
}

/** Manual captions first, then auto-captions. Tracks without a URL stay on the yt-dlp fallback. */
function selectDownloadableCaption(info: YtDump): { lang: string; track: YtCaptionTrack } | undefined {
  for (const map of [info.subtitles, info.automatic_captions]) {
    if (!map) continue;
    const langs = Object.keys(map).filter((lang) => bestUrlTrack(map[lang]));
    const lang = pickCaptionLang(langs);
    if (!lang) continue;
    const track = bestUrlTrack(map[lang]);
    if (track?.url) return { lang, track };
  }
  return undefined;
}

export function json3ToPlainText(raw: string): string {
  let data: { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
  try {
    data = JSON.parse(raw) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const event of data.events ?? []) {
    const text = (event.segs ?? [])
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\n/g, " ")
      .trim();
    if (!text || text === lines[lines.length - 1]) continue;
    lines.push(text);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

export function xmlCaptionToPlainText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function captionBodyToPlainText(body: string, ext?: string): string {
  const trimmed = body.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return "";
  const kind = (ext ?? "").toLowerCase();
  if (trimmed.startsWith("WEBVTT") || kind === "vtt" || kind === "srt") return vttToPlainText(trimmed);
  if (kind === "json3" || trimmed.startsWith("{")) {
    const asJson = json3ToPlainText(trimmed);
    if (asJson) return asJson;
  }
  return xmlCaptionToPlainText(trimmed);
}

async function defaultCaptionFetcher(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      accept: "text/vtt,application/json,text/xml,text/plain,*/*",
      "user-agent": "Mozilla/5.0",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`caption download failed: HTTP ${res.status}`);
  return res.text();
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
  if (t.includes("429") || t.includes("too many requests")) {
    return "YouTube rate-limited the caption download. Try again in a minute.";
  }
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

function videoCapture(url: string, canonicalUrl: string, info: YtDump, transcript: string): XCapture {
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
}

export async function captureYouTubeVideo(
  url: string,
  opts?: { runner?: YtDlpRunner; fetcher?: (captionUrl: string) => Promise<string> },
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

  const direct = selectDownloadableCaption(info);
  if (direct?.track.url) {
    try {
      const fetcher = opts?.fetcher ?? defaultCaptionFetcher;
      const body = await fetcher(direct.track.url);
      const transcript = captionBodyToPlainText(body, direct.track.ext);
      if (!transcript) return emptyCapture(url, canonicalUrl, "no transcript", info.title);
      return videoCapture(url, canonicalUrl, info, transcript);
    } catch (err) {
      return emptyCapture(
        url,
        canonicalUrl,
        mapYtDlpMessage(err instanceof Error ? err.message : String(err)),
        info.title,
      );
    }
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

    return videoCapture(url, canonicalUrl, info, transcript);
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
