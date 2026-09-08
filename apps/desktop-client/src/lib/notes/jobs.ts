import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultOipMemoryRoot } from "@alfred/memory";
import { activeProfileId } from "../oip-memory.js";

export type NoteJobStatus = "queued" | "processing" | "completed" | "failed";

export interface NoteJob {
  id: string;
  noteId: string;
  status: NoteJobStatus;
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const jobs = new Map<string, NoteJob>();
let persistQueue: Promise<void> = Promise.resolve();

function jobsPath(profileId?: string): string {
  const id = activeProfileId(profileId);
  const fromEnv = process.env.ALFRED_MEMORY_OIP_PATH?.trim();
  const root = fromEnv ? path.resolve(fromEnv) : defaultOipMemoryRoot(id);
  return path.join(root, "indexes", "audio-note-jobs.json");
}

async function persist(): Promise<void> {
  const file = jobsPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify([...jobs.values()], null, 2));
}

function schedulePersist(): void {
  persistQueue = persistQueue.then(() => persist()).catch((err) => {
    console.error("[notes] job persist failed:", err);
  });
}

export async function loadNoteJobs(): Promise<void> {
  try {
    const raw = await readFile(jobsPath(), "utf8");
    const parsed = JSON.parse(raw) as NoteJob[];
    for (const job of parsed) jobs.set(job.id, job);
  } catch {
    // first run
  }
}

export function createNoteJob(noteId: string): NoteJob {
  const now = new Date().toISOString();
  const job: NoteJob = {
    id: crypto.randomUUID(),
    noteId,
    status: "queued",
    progress: 0,
    message: "Queued",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  schedulePersist();
  return job;
}

export function getNoteJob(id: string): NoteJob | null {
  return jobs.get(id) ?? null;
}

export function listNoteJobs(): NoteJob[] {
  return [...jobs.values()];
}

export function latestJobForNote(noteId: string): NoteJob | null {
  return (
    [...jobs.values()]
      .filter((j) => j.noteId === noteId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

export function updateNoteJob(
  id: string,
  patch: Partial<Pick<NoteJob, "status" | "progress" | "message" | "error">>,
): NoteJob | null {
  const current = jobs.get(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(id, next);
  schedulePersist();
  return next;
}
