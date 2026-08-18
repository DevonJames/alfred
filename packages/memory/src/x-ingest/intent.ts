import type { XIngestIntent } from "./types.js";
import { extractInboxLinkUrls, isXUrl, isYouTubeUrl } from "./urls.js";

const INGEST_NOTES_RE =
  /\b(ingest|import|pull|process)\b[\s\S]{0,40}\b(x|twitter|youtube|yt)\b[\s\S]{0,20}\b(notes?|links?|inbox|articles?|posts?|threads?|videos?)\b/i;

const INGEST_NAMED_NOTE_RE =
  /\b(ingest|import|pull|process)\b[\s\S]{0,60}\b(?:my\s+)?([a-z][a-z0-9 _-]{1,40})\s+note\b/i;

const PULL_LINK_RE =
  /\b(go\s+)?(pull|ingest|save|grab)\b[\s\S]{0,40}\b(x|twitter|youtube|yt|link|post|article|thread|video)\b/i;

export function parseXIngestIntent(text: string, noteTitles: string[] = []): XIngestIntent | null {
  const urls = extractInboxLinkUrls(text).filter(
    (u) => isXUrl(u) || isYouTubeUrl(u) || /t\.co\//i.test(u),
  );
  if (urls[0] && (PULL_LINK_RE.test(text) || /https?:\/\//i.test(text))) {
    return { kind: "url", url: urls[0] };
  }
  const named = INGEST_NAMED_NOTE_RE.exec(text);
  if (named?.[2]) {
    const hint = named[2].trim();
    const match = noteTitles.find(
      (t) => t.toLowerCase() === hint.toLowerCase() || t.toLowerCase().includes(hint.toLowerCase()),
    );
    if (match) return { kind: "notes", note: match };
    if (!/\b(x|twitter|youtube)\s+notes?\b/i.test(text)) {
      return { kind: "notes", note: hint };
    }
  }
  if (INGEST_NOTES_RE.test(text) || /\bingest my (x|youtube)\b/i.test(text)) {
    const noteHint = noteTitles.find((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i").test(text));
    return { kind: "notes", note: noteHint };
  }
  if (urls[0] && /\b(x\.com|twitter\.com|youtube\.com|youtu\.be)\b/i.test(text)) {
    return { kind: "url", url: urls[0] };
  }
  return null;
}

export function looksLikeXIngest(text: string): boolean {
  return parseXIngestIntent(text) != null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "last week" / "yesterday" on ingest phrasing → learnedAt window. */
export function parseLearnedAtWindow(
  text: string,
  now = new Date(),
): { start: Date; end: Date; field: "learnedAt" | "published" } | null {
  const field: "learnedAt" | "published" = /\b(posted|published|written|came out)\b/i.test(text)
    ? "published"
    : "learnedAt";
  const end = now;
  let start: Date | undefined;
  if (/\byesterday\b/i.test(text)) {
    start = new Date(now.getTime() - 36 * 3600_000);
  } else if (/\blast week\b|\bpast week\b|\bthis week\b/i.test(text)) {
    start = new Date(now.getTime() - 8 * 24 * 3600_000);
  } else if (/\blast month\b|\bpast month\b/i.test(text)) {
    start = new Date(now.getTime() - 32 * 24 * 3600_000);
  } else if (/\btoday\b/i.test(text)) {
    start = new Date(now.getTime() - 24 * 3600_000);
  }
  if (!start) return null;
  return { start, end, field };
}
