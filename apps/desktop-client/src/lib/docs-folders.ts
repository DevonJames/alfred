import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addDocsSource,
  ingestDocsFolders,
  isDirectory,
  loadDocsLedger,
  loadDocsSources,
  removeDocsSource,
  speechFromDocsRun,
  type DocsIngestRunResult,
  type DocsSource,
} from "@alfred/memory";
import { activeProfileId } from "./oip-memory.js";

const execFileAsync = promisify(execFile);

export interface DocsFolderRow {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  trackedFiles: number;
  lastIngestedAt?: string;
}

export interface DocsFolderSchedule {
  time: string;
  timezone: string;
  label: string;
}

export interface DocsFolderList {
  schedule: DocsFolderSchedule;
  folders: DocsFolderRow[];
}

export function docsIngestSchedule(): DocsFolderSchedule {
  const timezone = process.env.BRIEFING_TIMEZONE ?? "America/Los_Angeles";
  const time =
    process.env.ALFRED_DOCS_INGEST_SCHEDULE?.trim() ||
    process.env.ALFRED_X_INGEST_SCHEDULE?.trim() ||
    "06:00";
  return { time, timezone, label: `daily at ${time} (${timezone})` };
}

export async function listWatchedDocsFolders(profileId = activeProfileId()): Promise<DocsFolderList> {
  const sources = await loadDocsSources(profileId);
  const ledger = await loadDocsLedger(profileId);
  const folders: DocsFolderRow[] = [];
  for (const source of sources) {
    folders.push(await rowForSource(source, ledger));
  }
  return { schedule: docsIngestSchedule(), folders };
}

async function rowForSource(
  source: DocsSource,
  ledger: Map<string, { path: string; lastIngestedAt?: string }>,
): Promise<DocsFolderRow> {
  const prefix = source.path.endsWith("/") ? source.path : `${source.path}/`;
  let trackedFiles = 0;
  let lastIngestedAt: string | undefined;
  for (const entry of ledger.values()) {
    if (entry.path === source.path || entry.path.startsWith(prefix)) {
      trackedFiles += 1;
      if (entry.lastIngestedAt && (!lastIngestedAt || entry.lastIngestedAt > lastIngestedAt)) {
        lastIngestedAt = entry.lastIngestedAt;
      }
    }
  }
  return {
    id: source.id,
    label: source.label,
    path: source.path,
    exists: await isDirectory(source.path),
    trackedFiles,
    lastIngestedAt,
  };
}

export function summarizeDocsRun(run: DocsIngestRunResult): {
  ingested: number;
  skipped: number;
  failed: number;
  speech: string;
} {
  return {
    ingested: run.processed.filter((p) => p.status === "ingested").length,
    skipped: run.processed.filter((p) => p.status === "skipped").length,
    failed: run.processed.filter((p) => p.status === "failed").length,
    speech: speechFromDocsRun(run),
  };
}

export async function addWatchedDocsFolder(opts: {
  path: string;
  label: string;
  /** When false, only register the folder (no scan). Default true. */
  ingest?: boolean;
  profileId?: string;
}): Promise<{ source: DocsSource; run?: ReturnType<typeof summarizeDocsRun> }> {
  const profileId = opts.profileId ?? activeProfileId();
  const dir = opts.path.trim();
  const label = opts.label.trim();
  if (!dir) throw new Error("Folder path is required");
  if (!label) throw new Error("Label is required");
  if (!(await isDirectory(dir))) {
    throw new Error(`Not a directory: ${dir}`);
  }
  const source = await addDocsSource(profileId, { path: dir, label });
  if (opts.ingest === false) return { source };
  const run = await ingestDocsFolders({ profileId, path: source.path });
  return { source, run: summarizeDocsRun(run) };
}

export async function removeWatchedDocsFolder(
  pathOrId: string,
  profileId = activeProfileId(),
): Promise<DocsSource> {
  const removed = await removeDocsSource(profileId, pathOrId);
  if (!removed) throw new Error(`No watched folder matching "${pathOrId}"`);
  return removed;
}

export async function scanWatchedDocsFolder(
  pathOrId: string,
  profileId = activeProfileId(),
): Promise<{ source: DocsSource; run: ReturnType<typeof summarizeDocsRun> }> {
  const sources = await loadDocsSources(profileId);
  const source =
    sources.find((s) => s.id === pathOrId) ??
    sources.find((s) => s.path === pathOrId) ??
    sources.find((s) => s.label === pathOrId);
  if (!source) throw new Error(`No watched folder matching "${pathOrId}"`);
  const run = await ingestDocsFolders({ profileId, path: source.path });
  return { source, run: summarizeDocsRun(run) };
}

export async function pickLocalMarkdownFolder(): Promise<
  { ok: true; path: string } | { ok: false; reason: "cancelled" | "unsupported" }
> {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "unsupported" };
  }
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose a folder of .md, .txt, .rtf, or .pdf files for Alfred to scan")',
    ]);
    const picked = stdout.trim().replace(/\/$/, "");
    if (!picked) return { ok: false, reason: "cancelled" };
    return { ok: true, path: picked };
  } catch {
    return { ok: false, reason: "cancelled" };
  }
}
