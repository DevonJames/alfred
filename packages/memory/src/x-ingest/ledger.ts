import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultXLedgerPath } from "./paths.js";
import type { XLedgerEntry } from "./types.js";
import { canonicalizeInboxUrl } from "./urls.js";

export async function loadXLedger(
  profileId: string,
  filePath = defaultXLedgerPath(profileId),
): Promise<Map<string, XLedgerEntry>> {
  const map = new Map<string, XLedgerEntry>();
  try {
    const raw = await readFile(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as XLedgerEntry;
      if (entry.canonicalUrl) map.set(entry.canonicalUrl, entry);
    }
  } catch {
    /* missing */
  }
  return map;
}

export async function saveXLedger(
  profileId: string,
  ledger: Map<string, XLedgerEntry>,
  filePath = defaultXLedgerPath(profileId),
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = [...ledger.values()].map((e) => JSON.stringify(e)).join("\n");
  await writeFile(filePath, lines ? `${lines}\n` : "", "utf8");
}

export function upsertLedgerEntry(
  ledger: Map<string, XLedgerEntry>,
  patch: Partial<XLedgerEntry> & { url: string },
): XLedgerEntry {
  const canonicalUrl = patch.canonicalUrl ?? canonicalizeInboxUrl(patch.url);
  const prev = ledger.get(canonicalUrl);
  const noteNames = unique([...(prev?.noteNames ?? []), ...(patch.noteNames ?? [])]);
  const noteFolders = unique([...(prev?.noteFolders ?? []), ...(patch.noteFolders ?? [])]);
  const next: XLedgerEntry = {
    url: patch.url,
    canonicalUrl,
    status: patch.status ?? prev?.status ?? "in_progress",
    kind: patch.kind ?? prev?.kind,
    headline: patch.headline ?? prev?.headline,
    author: patch.author ?? prev?.author,
    authorHandle: patch.authorHandle ?? prev?.authorHandle,
    noteNames,
    noteFolders,
    contentHash: patch.contentHash ?? prev?.contentHash,
    lastIngestedAt: patch.lastIngestedAt ?? prev?.lastIngestedAt,
    memoryDid: patch.memoryDid ?? prev?.memoryDid,
    error: patch.error,
    errorHeadline: patch.errorHeadline ?? prev?.errorHeadline,
  };
  ledger.set(canonicalUrl, next);
  return next;
}

function unique(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

/** Inbox URLs that are new, failed, or explicitly re-queued (present in the note). */
export function urlsToProcess(
  inboxUrls: string[],
  ledger: Map<string, XLedgerEntry>,
): { url: string; canonicalUrl: string; entry?: XLedgerEntry }[] {
  const out: { url: string; canonicalUrl: string; entry?: XLedgerEntry }[] = [];
  const seen = new Set<string>();
  for (const url of inboxUrls) {
    const canonicalUrl = canonicalizeInboxUrl(url);
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    const entry = ledger.get(canonicalUrl);
    if (!entry || entry.status === "failed" || entry.status === "in_progress") {
      out.push({ url, canonicalUrl, entry });
      continue;
    }
    // Present in inbox again after a successful ingest → refresh
    out.push({ url, canonicalUrl, entry });
  }
  return out;
}
