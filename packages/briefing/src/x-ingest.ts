import type { XIngestDigest } from "@alfred/memory";
import type { XIngestBriefing } from "./types.js";

export function formatXIngestSpeech(digest: XIngestDigest | null | undefined): string {
  if (!digest?.items.length) return "";
  const ok = digest.items.filter((i) => i.status === "ingested");
  const failed = digest.items.filter((i) => i.status === "failed");
  const parts: string[] = [];

  if (ok.length === 1) {
    const item = ok[0]!;
    const from = item.noteName ? ` from your ${item.noteName} note` : "";
    const author = item.author ? ` by ${item.author}` : "";
    const body = (item.summary ?? item.headline).replace(/\s+/g, " ").trim();
    parts.push(`From X${from}: ${item.headline}${author}. ${body}`);
  } else if (ok.length > 1) {
    const subjects = ok.map((i) => {
      const note = i.noteName ? ` (${i.noteName})` : "";
      return `${i.headline}${note}`;
    });
    parts.push(`I saved ${ok.length} items from X: ${subjects.join("; ")}.`);
  }

  for (const f of failed) {
    const title = f.headline || f.url;
    const why = f.error ?? "an unknown error";
    parts.push(`The link titled ${title} could not be ingested because of ${why}.`);
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
      lines.push(`- Failed${note}: ${i.headline} (${i.error ?? "error"})`);
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
