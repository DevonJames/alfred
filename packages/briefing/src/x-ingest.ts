import type { XIngestDigest } from "@alfred/memory";
import type { XIngestBriefing } from "./types.js";

/** Playwright dumps are not speakable — keep a short reason for the briefing. */
function sanitizeIngestError(error: string | undefined): string {
  const raw = (error ?? "an unknown error").replace(/\s+/g, " ").trim();
  if (!raw) return "an unknown error";
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE|page\.goto|Call log|net::ERR_/i.test(raw)) {
    return "the page could not be loaded";
  }
  if (/paywall/i.test(raw)) return "a paywall";
  if (/timeout/i.test(raw)) return "a timeout";
  if (/no transcript/i.test(raw)) return "no transcript";
  // First clause only; drop stack / call-log tails.
  const short = raw.split(/ at Call log:| waiting until |:\s*Error:/i)[0]!.trim();
  if (short.length > 80) return `${short.slice(0, 77).trim()}…`;
  return short || "an unknown error";
}

export function formatXIngestSpeech(digest: XIngestDigest | null | undefined): string {
  if (!digest?.items.length) return "";
  const ok = digest.items.filter((i) => i.status === "ingested");
  const failed = digest.items.filter((i) => i.status === "failed");
  const parts: string[] = [];

  if (ok.length === 1) {
    const item = ok[0]!;
    const source = item.kind === "video" ? "YouTube" : "X";
    const from = item.noteName ? ` from your ${item.noteName} note` : "";
    const author = item.author ? ` by ${item.author}` : "";
    const body = (item.summary ?? item.headline).replace(/\s+/g, " ").trim();
    parts.push(`From ${source}${from}: ${item.headline}${author}. ${body}`);
  } else if (ok.length > 1) {
    const labels = [...new Set(ok.map((i) => (i.kind === "video" ? "YouTube" : "X")))];
    const noteHint = ok.find((i) => i.noteName)?.noteName
      ? ` from your ${ok.find((i) => i.noteName)!.noteName} note`
      : "";
    const listed = ok.slice(0, 4).map((i) => i.headline);
    const extra = ok.length - listed.length;
    const tail = extra > 0 ? `; and ${extra} more` : "";
    parts.push(
      `I saved ${ok.length} items from ${labels.join(" and ")}${noteHint}: ${listed.join("; ")}${tail}.`,
    );
  }

  if (failed.length === 1) {
    const f = failed[0]!;
    const title = f.headline || f.url;
    const why = sanitizeIngestError(f.error);
    const noun = f.kind === "video" || /youtube|youtu\.be/i.test(f.url) ? "YouTube video" : "link";
    parts.push(`The ${noun} titled ${title} could not be ingested because of ${why}.`);
  } else if (failed.length > 1) {
    // Do not read dozens of Playwright stack traces aloud.
    parts.push(
      `${failed.length} saved links could not be ingested — mostly pages that failed to load.`,
    );
  }
  return parts.join(" ").trim();
}

export function formatXIngestMarkdown(digest: {
  items: Array<{
    headline: string;
    noteName?: string;
    author?: string;
    status: "ingested" | "failed";
    error?: string;
  }>;
} | null | undefined): string {
  if (!digest?.items.length) return "";
  const lines = ["**X ingest**", ""];
  for (const i of digest.items) {
    const note = i.noteName ? ` · ${i.noteName}` : "";
    if (i.status === "failed") {
      lines.push(`- Failed${note}: ${i.headline} (${sanitizeIngestError(i.error)})`);
    } else {
      lines.push(`- ${i.headline}${note}${i.author ? ` — ${i.author}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function toXIngestBriefing(digest: XIngestDigest | null): XIngestBriefing | null {
  if (!digest?.items.length) return null;
  return {
    items: digest.items,
    speech: formatXIngestSpeech(digest) || null,
  };
}
