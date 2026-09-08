import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { activeProfileId, oipRootForProfile } from "../oip-memory.js";
import { getAudioNote, queueNoteFromAudio, type AudioNoteDto } from "./service.js";
import type { NoteJob } from "./jobs.js";

export const NOTE_UPLOAD_CHUNK_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const STALE_MS = 48 * 60 * 60 * 1000;

export type NoteUploadStatus = "uploading" | "assembling" | "completed" | "failed";

export interface NoteUpload {
  id: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  contentHash: string | null;
  title?: string;
  template?: string;
  attendees?: unknown;
  durationSeconds?: number;
  chunkSize: number;
  totalChunks: number;
  received: number[];
  status: NoteUploadStatus;
  noteId?: string;
  jobId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function uploadsRoot(profileId?: string): string {
  return path.join(oipRootForProfile(activeProfileId(profileId)), "indexes", "audio-uploads");
}

function sessionDir(id: string, profileId?: string): string {
  return path.join(uploadsRoot(profileId), id);
}

function metaPath(id: string, profileId?: string): string {
  return path.join(sessionDir(id, profileId), "meta.json");
}

function chunkPath(id: string, index: number, profileId?: string): string {
  return path.join(sessionDir(id, profileId), `chunk-${String(index).padStart(5, "0")}`);
}

async function readMeta(id: string, profileId?: string): Promise<NoteUpload | null> {
  try {
    const raw = await readFile(metaPath(id, profileId), "utf8");
    return JSON.parse(raw) as NoteUpload;
  } catch {
    return null;
  }
}

async function writeMeta(upload: NoteUpload, profileId?: string): Promise<NoteUpload> {
  const next = { ...upload, updatedAt: new Date().toISOString() };
  await mkdir(sessionDir(next.id, profileId), { recursive: true });
  await writeFile(metaPath(next.id, profileId), JSON.stringify(next, null, 2));
  return next;
}

export async function createNoteUpload(opts: {
  filename: string;
  mimeType?: string;
  byteLength: number;
  contentHash?: string;
  title?: string;
  template?: string;
  attendees?: unknown;
  durationSeconds?: number;
  profileId?: string;
}): Promise<NoteUpload> {
  const byteLength = Math.floor(Number(opts.byteLength));
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new Error("byteLength is required");
  }
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("Recording is larger than 300 MB");
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const chunkSize = NOTE_UPLOAD_CHUNK_BYTES;
  const upload: NoteUpload = {
    id,
    filename: opts.filename.trim() || "recording.m4a",
    mimeType: opts.mimeType?.trim() || "audio/mp4",
    byteLength,
    contentHash: opts.contentHash?.trim() || null,
    title: opts.title?.trim() || undefined,
    template: opts.template,
    attendees: opts.attendees,
    durationSeconds: opts.durationSeconds,
    chunkSize,
    totalChunks: Math.ceil(byteLength / chunkSize),
    received: [],
    status: "uploading",
    createdAt: now,
    updatedAt: now,
  };
  return writeMeta(upload, opts.profileId);
}

export async function getNoteUpload(id: string, profileId?: string): Promise<NoteUpload | null> {
  return readMeta(id, profileId);
}

export async function putNoteChunk(opts: {
  id: string;
  index: number;
  data: string;
  profileId?: string;
}): Promise<NoteUpload> {
  const upload = await readMeta(opts.id, opts.profileId);
  if (!upload) throw new Error("Upload not found");
  if (upload.status === "completed") return upload;
  if (upload.status !== "uploading") throw new Error("Upload is no longer accepting chunks");
  const index = Math.floor(Number(opts.index));
  if (!Number.isInteger(index) || index < 0 || index >= upload.totalChunks) {
    throw new Error("Invalid chunk index");
  }
  const bytes = Buffer.from(opts.data.replace(/\s+/g, ""), "base64");
  if (!bytes.length) throw new Error("Chunk is empty");
  const expected =
    index === upload.totalChunks - 1
      ? upload.byteLength - upload.chunkSize * (upload.totalChunks - 1)
      : upload.chunkSize;
  if (bytes.length !== expected) {
    throw new Error(`Chunk ${index} was ${bytes.length} bytes, expected ${expected}`);
  }
  await mkdir(sessionDir(upload.id, opts.profileId), { recursive: true });
  await writeFile(chunkPath(upload.id, index, opts.profileId), bytes);
  if (!upload.received.includes(index)) {
    upload.received = [...upload.received, index].sort((a, b) => a - b);
  }
  return writeMeta(upload, opts.profileId);
}

async function assembleBytes(upload: NoteUpload, profileId?: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let index = 0; index < upload.totalChunks; index += 1) {
    if (!upload.received.includes(index)) {
      throw new Error(`Missing chunk ${index}`);
    }
    parts.push(await readFile(chunkPath(upload.id, index, profileId)));
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== upload.byteLength) {
    throw new Error(`Assembled ${bytes.length} bytes, expected ${upload.byteLength}`);
  }
  if (upload.contentHash) {
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const expected = upload.contentHash.startsWith("sha256:")
      ? upload.contentHash
      : `sha256:${upload.contentHash}`;
    if (hash !== expected) throw new Error("Recording hash did not match");
  }
  return bytes;
}

const completing = new Map<string, Promise<{ upload: NoteUpload; note: AudioNoteDto; job: NoteJob }>>();

function completeKey(id: string, profileId?: string): string {
  return `${profileId ?? ""}:${id}`;
}

async function runCompleteNoteUpload(
  id: string,
  profileId?: string,
): Promise<{ upload: NoteUpload; note: AudioNoteDto; job: NoteJob }> {
  const upload = await readMeta(id, profileId);
  if (!upload) throw new Error("Upload not found");
  if (upload.status === "completed" && upload.noteId) {
    const note = await getAudioNote(upload.noteId, profileId);
    if (note) {
      return {
        upload,
        note,
        job: note.job ?? {
          id: upload.jobId ?? "",
          noteId: note.id,
          status: "completed",
          progress: 100,
          message: "Complete",
          error: null,
          createdAt: upload.createdAt,
          updatedAt: upload.updatedAt,
        },
      };
    }
  }
  if (upload.received.length !== upload.totalChunks) {
    throw new Error(`Upload is incomplete (${upload.received.length}/${upload.totalChunks} chunks)`);
  }
  await writeMeta({ ...upload, status: "assembling" }, profileId);
  try {
    const bytes = await assembleBytes(upload, profileId);
    const queued = await queueNoteFromAudio({
      bytes,
      filename: upload.filename,
      mimeType: upload.mimeType,
      title: upload.title,
      template: upload.template,
      attendees: upload.attendees,
      durationSeconds: upload.durationSeconds,
      profileId,
    });
    for (let index = 0; index < upload.totalChunks; index += 1) {
      await rm(chunkPath(upload.id, index, profileId), { force: true }).catch(() => undefined);
    }
    const completed = await writeMeta(
      {
        ...upload,
        status: "completed",
        noteId: queued.note.id,
        jobId: queued.job.id,
        error: undefined,
      },
      profileId,
    );
    return { upload: completed, note: queued.note, job: queued.job };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeMeta({ ...upload, status: "failed", error: message }, profileId);
    throw err;
  }
}

/**
 * Kick off assemble + ingest without waiting. The alfrd.net hub only waits
 * ~30s per hop; joining a 1–2 hour m4a can take longer than that.
 */
export async function requestCompleteNoteUpload(
  id: string,
  profileId?: string,
): Promise<NoteUpload> {
  const existing = await readMeta(id, profileId);
  if (!existing) throw new Error("Upload not found");
  if (existing.status === "completed" && existing.noteId) return existing;
  if (existing.received.length !== existing.totalChunks && existing.status !== "assembling") {
    throw new Error(`Upload is incomplete (${existing.received.length}/${existing.totalChunks} chunks)`);
  }
  void completeNoteUpload(id, profileId);
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const current = await readMeta(id, profileId);
    if (current && current.status !== "uploading") return current;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return (await readMeta(id, profileId)) ?? existing;
}

export async function resumeAssemblingNoteUploads(profileId?: string): Promise<void> {
  const root = uploadsRoot(profileId);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const upload = await readMeta(name, profileId);
    if (upload?.status !== "assembling") continue;
    console.log(`[notes] Resuming assemble for upload ${upload.id}`);
    void requestCompleteNoteUpload(upload.id, profileId).catch((err) => {
      console.warn(`[notes] Resume assemble failed for ${upload.id}:`, err);
    });
  }
}

export async function completeNoteUpload(
  id: string,
  profileId?: string,
): Promise<{ upload: NoteUpload; note: AudioNoteDto; job: NoteJob }> {
  const key = completeKey(id, profileId);
  const inFlight = completing.get(key);
  if (inFlight) return inFlight;
  const work = runCompleteNoteUpload(id, profileId).finally(() => {
    completing.delete(key);
  });
  completing.set(key, work);
  return work;
}

export async function pruneStaleNoteUploads(profileId?: string): Promise<void> {
  const root = uploadsRoot(profileId);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const name of names) {
    const upload = await readMeta(name, profileId);
    if (!upload) continue;
    if (Date.parse(upload.updatedAt) > cutoff) continue;
    if (upload.status === "uploading" || upload.status === "failed") {
      await rm(sessionDir(name, profileId), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
