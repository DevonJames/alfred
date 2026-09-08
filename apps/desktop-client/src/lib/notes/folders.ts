import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  audioMimeFromFilename,
  defaultOipMemoryRoot,
  isAudioNoteFilename,
  type AudioNoteTemplate,
} from "@alfred/memory";
import { activeProfileId } from "../oip-memory.js";
import { cancelFolderWork, enqueueNoteWork, listNoteWork, noteWorkStatus, setFolderQueuePaused, type NoteWorkItem } from "./queue.js";

const execFileAsync = promisify(execFile);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "data"]);

export interface AudioNoteFolderSource {
  id: string;
  path: string;
  label: string;
  createdAt: string;
}

export interface AudioNoteFolderLedgerEntry {
  key: string;
  folderId: string;
  absPath: string;
  relPath: string;
  contentHash: string;
  episodeId?: string;
  status: "queued" | "processing" | "completed" | "failed";
  error?: string;
  lastIngestedAt?: string;
}

export interface AudioNoteFolderRow {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  trackedFiles: number;
  queued: number;
  processing: number;
  failed: number;
  lastIngestedAt?: string;
}

function rootDir(profileId?: string): string {
  const id = activeProfileId(profileId);
  const fromEnv = process.env.ALFRED_MEMORY_OIP_PATH?.trim();
  return fromEnv ? path.resolve(fromEnv) : defaultOipMemoryRoot(id);
}

function sourcesPath(profileId?: string): string {
  return path.join(rootDir(profileId), "indexes", "audio-note-folders.json");
}

function ledgerPath(profileId?: string): string {
  return path.join(rootDir(profileId), "indexes", "audio-note-folder-ledger.json");
}

async function loadJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function saveJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

export async function loadAudioNoteFolders(profileId?: string): Promise<AudioNoteFolderSource[]> {
  return loadJson(sourcesPath(profileId), []);
}

export async function loadAudioNoteFolderLedger(
  profileId?: string,
): Promise<Map<string, AudioNoteFolderLedgerEntry>> {
  const rows = await loadJson<AudioNoteFolderLedgerEntry[]>(ledgerPath(profileId), []);
  return new Map(rows.map((row) => [row.key, row]));
}

async function saveLedger(
  ledger: Map<string, AudioNoteFolderLedgerEntry>,
  profileId?: string,
): Promise<void> {
  await saveJson(ledgerPath(profileId), [...ledger.values()]);
}

function ledgerKey(folderId: string, relPath: string): string {
  return `${folderId}:${relPath}`;
}

export async function walkAudioNoteFiles(root: string): Promise<Array<{ absPath: string; relPath: string }>> {
  const resolved = path.resolve(root);
  const out: Array<{ absPath: string; relPath: string }> = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile() || !isAudioNoteFilename(entry.name)) continue;
      out.push({
        absPath: abs,
        relPath: path.relative(resolved, abs).split(path.sep).join("/"),
      });
    }
  };
  await walk(resolved);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function readSidecar(absPath: string): Promise<{
  title?: string;
  template?: AudioNoteTemplate;
  attendees?: string[];
  location?: string;
  durationSeconds?: number;
} | null> {
  const sidecar = absPath.replace(/\.[^.]+$/, ".json");
  try {
    const raw = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
    const templateRaw = String(raw.template ?? "").toLowerCase();
    const template =
      templateRaw === "meeting" ||
      templateRaw === "brainstorm" ||
      templateRaw === "checkin" ||
      templateRaw === "freeform"
        ? templateRaw
        : undefined;
    return {
      title: typeof raw.title === "string" ? raw.title : undefined,
      template,
      attendees: Array.isArray(raw.attendees) ? raw.attendees.map((a) => String(a).trim()).filter(Boolean) : undefined,
      location: typeof raw.location === "string" ? raw.location : undefined,
      durationSeconds: typeof raw.durationSeconds === "number" ? raw.durationSeconds : undefined,
    };
  } catch {
    return null;
  }
}

export async function listAudioNoteFolders(profileId?: string): Promise<{
  folders: AudioNoteFolderRow[];
  queue: ReturnType<typeof noteWorkStatus>;
}> {
  const sources = await loadAudioNoteFolders(profileId);
  const ledger = await loadAudioNoteFolderLedger(profileId);
  const folders: AudioNoteFolderRow[] = [];
  for (const source of sources) {
    const rows = [...ledger.values()].filter((row) => row.folderId === source.id);
    let exists = false;
    try {
      exists = (await stat(source.path)).isDirectory();
    } catch {
      exists = false;
    }
    folders.push({
      id: source.id,
      label: source.label,
      path: source.path,
      exists,
      trackedFiles: rows.filter((row) => row.status === "completed").length,
      queued: rows.filter((row) => row.status === "queued").length,
      processing: rows.filter((row) => row.status === "processing").length,
      failed: rows.filter((row) => row.status === "failed").length,
      lastIngestedAt: rows
        .map((row) => row.lastIngestedAt)
        .filter(Boolean)
        .sort()
        .at(-1),
    });
  }
  return { folders, queue: noteWorkStatus() };
}

export async function addAudioNoteFolder(opts: {
  path: string;
  label: string;
  ingest?: boolean;
  profileId?: string;
}): Promise<{ source: AudioNoteFolderSource; enqueued: number }> {
  const dir = opts.path.trim();
  const label = opts.label.trim();
  if (!dir) throw new Error("Folder path is required");
  if (!label) throw new Error("Label is required");
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const sources = await loadAudioNoteFolders(opts.profileId);
  const existing = sources.find((s) => s.path === path.resolve(dir));
  const source =
    existing ??
    ({
      id: crypto.randomUUID(),
      path: path.resolve(dir),
      label,
      createdAt: new Date().toISOString(),
    } satisfies AudioNoteFolderSource);
  if (!existing) {
    source.label = label;
    sources.push(source);
    await saveJson(sourcesPath(opts.profileId), sources);
  } else if (existing.label !== label) {
    existing.label = label;
    await saveJson(sourcesPath(opts.profileId), sources);
  }
  const enqueued = opts.ingest === false ? 0 : await scanAudioNoteFolder(source.id, opts.profileId);
  return { source, enqueued };
}

export async function removeAudioNoteFolder(id: string, profileId?: string): Promise<AudioNoteFolderSource> {
  const sources = await loadAudioNoteFolders(profileId);
  const index = sources.findIndex((s) => s.id === id || s.path === id || s.label === id);
  if (index < 0) throw new Error(`No voice-note folder matching "${id}"`);
  const [removed] = sources.splice(index, 1);
  await saveJson(sourcesPath(profileId), sources);
  cancelFolderWork(removed!.id);
  return removed!;
}

export async function scanAudioNoteFolder(id: string, profileId?: string): Promise<number> {
  const sources = await loadAudioNoteFolders(profileId);
  const source = sources.find((s) => s.id === id || s.path === id || s.label === id);
  if (!source) throw new Error(`No voice-note folder matching "${id}"`);
  const files = await walkAudioNoteFiles(source.path);
  const ledger = await loadAudioNoteFolderLedger(profileId);
  let enqueued = 0;
  for (const file of files) {
    const bytes = await readFile(file.absPath);
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const key = ledgerKey(source.id, file.relPath);
    const prev = ledger.get(key);
    if (prev?.contentHash === contentHash && prev.status === "completed") {
      continue;
    }
    const alreadyQueued = listNoteWork().some(
      (item) => item.absPath === file.absPath && (item.status === "queued" || item.status === "paused" || item.status === "processing"),
    );
    if (alreadyQueued) continue;
    const sidecar = await readSidecar(file.absPath);
    enqueueNoteWork({
      priority: "folder",
      source: "folder",
      filename: path.basename(file.absPath),
      mimeType: audioMimeFromFilename(file.absPath),
      title: sidecar?.title,
      template: sidecar?.template ?? "freeform",
      attendees: sidecar?.attendees ?? [],
      durationSeconds: sidecar?.durationSeconds,
      folderId: source.id,
      folderLabel: source.label,
      absPath: file.absPath,
      relPath: file.relPath,
      contentHash,
      nameFromFolder: true,
      profileId,
    });
    ledger.set(key, {
      key,
      folderId: source.id,
      absPath: file.absPath,
      relPath: file.relPath,
      contentHash,
      status: "queued",
    });
    enqueued += 1;
  }
  await saveLedger(ledger, profileId);
  return enqueued;
}

export async function markFolderWorkStarted(item: NoteWorkItem): Promise<void> {
  if (!item.folderId || !item.relPath) return;
  const ledger = await loadAudioNoteFolderLedger(item.profileId);
  const key = ledgerKey(item.folderId, item.relPath);
  const prev = ledger.get(key);
  ledger.set(key, {
    key,
    folderId: item.folderId,
    absPath: item.absPath ?? prev?.absPath ?? "",
    relPath: item.relPath,
    contentHash: item.contentHash ?? prev?.contentHash ?? "",
    episodeId: item.noteId ?? prev?.episodeId,
    status: "processing",
    lastIngestedAt: prev?.lastIngestedAt,
  });
  await saveLedger(ledger, item.profileId);
}

export async function markFolderWorkResult(item: NoteWorkItem, status: "completed" | "failed", error?: string): Promise<void> {
  if (!item.folderId || !item.relPath) return;
  const ledger = await loadAudioNoteFolderLedger(item.profileId);
  const key = ledgerKey(item.folderId, item.relPath);
  const prev = ledger.get(key);
  ledger.set(key, {
    key,
    folderId: item.folderId,
    absPath: item.absPath ?? prev?.absPath ?? "",
    relPath: item.relPath,
    contentHash: item.contentHash ?? prev?.contentHash ?? "",
    episodeId: item.noteId ?? prev?.episodeId,
    status,
    error,
    lastIngestedAt: new Date().toISOString(),
  });
  await saveLedger(ledger, item.profileId);
}

export async function pickLocalAudioFolder(): Promise<
  { ok: true; path: string } | { ok: false; reason: "cancelled" | "unsupported" }
> {
  if (process.platform !== "darwin") return { ok: false, reason: "unsupported" };
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Choose a folder of voice recordings for Alfred to ingest")',
    ]);
    const picked = stdout.trim().replace(/\/$/, "");
    if (!picked) return { ok: false, reason: "cancelled" };
    return { ok: true, path: picked };
  } catch {
    return { ok: false, reason: "cancelled" };
  }
}

export { noteWorkStatus, setFolderQueuePaused };
