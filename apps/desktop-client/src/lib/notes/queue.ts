/**
 * One notes worker: folder ingest and iPhone uploads share this queue.
 * Interactive (phone / UI / retry) always jumps ahead of folder files.
 * Folder STT yields at a 5-minute chunk boundary when an interactive job arrives.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultOipMemoryRoot, type AudioNoteTemplate } from "@alfred/memory";
import { activeProfileId } from "../oip-memory.js";
import { getNoteJob } from "./jobs.js";
import { runNoteJob } from "./job-runner.js";

export type NoteWorkPriority = "interactive" | "folder";
export type NoteWorkStatus = "queued" | "processing" | "paused" | "completed" | "failed";

export interface NoteWorkItem {
  id: string;
  priority: NoteWorkPriority;
  source: "ios" | "ui" | "folder" | "retry" | "resume";
  status: NoteWorkStatus;
  noteId?: string;
  jobId?: string;
  filename: string;
  mimeType: string;
  title?: string;
  template: AudioNoteTemplate;
  attendees: string[];
  durationSeconds?: number;
  profileId?: string;
  folderId?: string;
  folderLabel?: string;
  folderDid?: string;
  absPath?: string;
  relPath?: string;
  contentHash?: string;
  nameFromFolder?: boolean;
  nextChunk?: number;
  partialTranscript?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const items = new Map<string, NoteWorkItem>();
let persistChain: Promise<void> = Promise.resolve();
let pumping = false;
let folderQueuePaused = false;

function queuePath(profileId?: string): string {
  const id = activeProfileId(profileId);
  const fromEnv = process.env.ALFRED_MEMORY_OIP_PATH?.trim();
  const root = fromEnv ? path.resolve(fromEnv) : defaultOipMemoryRoot(id);
  return path.join(root, "indexes", "audio-note-queue.json");
}

async function persist(): Promise<void> {
  const file = queuePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify([...items.values()], null, 2));
}

function schedulePersist(): void {
  persistChain = persistChain.then(() => persist()).catch((err) => {
    console.error("[notes] queue persist failed:", err);
  });
}

function touch(item: NoteWorkItem, patch: Partial<NoteWorkItem>): NoteWorkItem {
  const next = { ...item, ...patch, updatedAt: new Date().toISOString() };
  items.set(item.id, next);
  schedulePersist();
  return next;
}

export function listNoteWork(): NoteWorkItem[] {
  return [...items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function updateNoteWork(id: string, patch: Partial<NoteWorkItem>): NoteWorkItem | null {
  const current = items.get(id);
  if (!current) return null;
  return touch(current, patch);
}

export function noteWorkStatus(): {
  active: NoteWorkItem | null;
  queuedInteractive: number;
  queuedFolder: number;
  pausedFolder: number;
  folderQueuePaused: boolean;
  message: string;
} {
  const all = listNoteWork();
  const active = all.find((item) => item.status === "processing") ?? null;
  const queuedInteractive = all.filter((item) => item.priority === "interactive" && item.status === "queued").length;
  const queuedFolder = all.filter((item) => item.priority === "folder" && item.status === "queued").length;
  const pausedFolder = all.filter((item) => item.priority === "folder" && item.status === "paused").length;
  let message = "Idle";
  if (folderQueuePaused && queuedFolder + pausedFolder > 0) message = "Folder ingest paused";
  if (active) {
    const job = active.jobId ? getNoteJob(active.jobId) : null;
    const detail = job?.message ? ` — ${job.message}${job.progress ? ` (${job.progress}%)` : ""}` : "";
    message =
      active.priority === "interactive"
        ? `Processing iPhone / UI note: ${active.filename}${detail}`
        : `Folder ingest: ${active.filename}${detail}`;
    if (queuedInteractive && active.priority === "folder") {
      message += " — will pause for iPhone recording after this chunk";
    }
  } else if (queuedInteractive) {
    message = `Queued iPhone / UI notes: ${queuedInteractive}`;
  } else if (queuedFolder || pausedFolder) {
    message = `Folder queue: ${queuedFolder + pausedFolder} remaining`;
  }
  return { active, queuedInteractive, queuedFolder, pausedFolder, folderQueuePaused, message };
}

export function setFolderQueuePaused(paused: boolean): void {
  folderQueuePaused = paused;
  if (!paused) void pumpNoteWorker();
}

export function isFolderQueuePaused(): boolean {
  return folderQueuePaused;
}

export async function loadNoteQueue(): Promise<void> {
  try {
    const raw = await readFile(queuePath(), "utf8");
    const parsed = JSON.parse(raw) as NoteWorkItem[];
    for (const item of parsed) {
      if (item.status === "processing") item.status = item.nextChunk != null ? "paused" : "queued";
      items.set(item.id, item);
    }
  } catch {
    // first run
  }
}

export function cancelFolderWork(folderId: string): void {
  for (const item of items.values()) {
    if (item.folderId === folderId && (item.status === "queued" || item.status === "paused")) {
      touch(item, { status: "failed", error: "Folder removed" });
    }
  }
}

export function enqueueNoteWork(input: Omit<NoteWorkItem, "id" | "status" | "createdAt" | "updatedAt"> & {
  id?: string;
  status?: NoteWorkStatus;
}): NoteWorkItem {
  const now = new Date().toISOString();
  const item: NoteWorkItem = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    status: input.status ?? "queued",
    createdAt: now,
    updatedAt: now,
  };
  items.set(item.id, item);
  schedulePersist();
  void pumpNoteWorker();
  return item;
}

function pickNext(): NoteWorkItem | null {
  const all = listNoteWork();
  const interactive = all.find((item) => item.priority === "interactive" && (item.status === "queued" || item.status === "paused"));
  if (interactive) return interactive;
  if (folderQueuePaused) return null;
  return all.find((item) => item.priority === "folder" && (item.status === "queued" || item.status === "paused")) ?? null;
}

function interactiveWaiting(): boolean {
  return listNoteWork().some((item) => item.priority === "interactive" && (item.status === "queued" || item.status === "paused"));
}

export async function pumpNoteWorker(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const item = pickNext();
      if (!item) break;
      touch(item, { status: "processing" });
      console.log(`[notes] worker ${item.priority} ${item.filename}`);
      const result = await runNoteJob(item, {
        shouldYield: () => item.priority === "folder" && interactiveWaiting(),
      });
      const current = items.get(item.id);
      if (!current) continue;
      if (result.yielded) {
        touch(current, {
          status: "paused",
          nextChunk: result.nextChunk,
          partialTranscript: result.transcript,
          noteId: result.noteId ?? current.noteId,
          jobId: result.jobId ?? current.jobId,
        });
        continue;
      }
      if (result.failed) {
        touch(current, {
          status: "failed",
          error: result.error,
          noteId: result.noteId ?? current.noteId,
          jobId: result.jobId ?? current.jobId,
        });
        continue;
      }
      touch(current, {
        status: "completed",
        noteId: result.noteId ?? current.noteId,
        jobId: result.jobId ?? current.jobId,
        nextChunk: undefined,
        partialTranscript: undefined,
        error: undefined,
      });
    }
  } finally {
    pumping = false;
    if (pickNext()) void pumpNoteWorker();
  }
}
