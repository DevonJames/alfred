import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultDocsLedgerPath } from "./paths.js";
import type { DocsLedgerEntry } from "./types.js";

export async function loadDocsLedger(
  profileId: string,
  filePath = defaultDocsLedgerPath(profileId),
): Promise<Map<string, DocsLedgerEntry>> {
  const map = new Map<string, DocsLedgerEntry>();
  try {
    const raw = await readFile(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as DocsLedgerEntry;
      if (entry.path) map.set(entry.path, entry);
    }
  } catch {
    /* missing */
  }
  return map;
}

export async function saveDocsLedger(
  profileId: string,
  ledger: Map<string, DocsLedgerEntry>,
  filePath = defaultDocsLedgerPath(profileId),
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = [...ledger.values()].map((e) => JSON.stringify(e)).join("\n");
  await writeFile(filePath, lines ? `${lines}\n` : "", "utf8");
}

export function upsertDocsLedgerEntry(
  ledger: Map<string, DocsLedgerEntry>,
  patch: DocsLedgerEntry,
): DocsLedgerEntry {
  const prev = ledger.get(patch.path);
  const next: DocsLedgerEntry = {
    ...prev,
    ...patch,
    sectionKeys: patch.sectionKeys ?? prev?.sectionKeys ?? {},
    extractDids: patch.extractDids ?? prev?.extractDids ?? [],
  };
  ledger.set(next.path, next);
  return next;
}
