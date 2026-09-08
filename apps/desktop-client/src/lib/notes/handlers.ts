import type { Context } from "hono";
import {
  createNoteFromAudio,
  getAudioNote,
  getNoteAudioChunk,
  getNoteAudioMeta,
  listAudioNotes,
  queueNoteFromAudio,
  readAudioNoteBytes,
  retryNoteDetails,
  retryNoteTranscript,
} from "./service.js";
import { getNoteJob } from "./jobs.js";
import {
  NOTE_UPLOAD_CHUNK_BYTES,
  createNoteUpload,
  getNoteUpload,
  putNoteChunk,
  requestCompleteNoteUpload,
} from "./uploads.js";

async function audioForm(c: Context): Promise<{
  bytes: Buffer;
  filename: string;
  mimeType?: string;
  title?: string;
  template?: string;
  attendees?: unknown;
  durationSeconds?: number;
}> {
  const form = await c.req.parseBody({ all: true });
  const file = form.audio ?? form.file;
  if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
    throw new Error("audio file is required");
  }
  const uploaded = file as File;
  const durationRaw = typeof form.durationSeconds === "string" ? Number(form.durationSeconds) : NaN;
  return {
    bytes: Buffer.from(await uploaded.arrayBuffer()),
    filename: uploaded.name || "recording.m4a",
    mimeType: uploaded.type || undefined,
    title: typeof form.title === "string" ? form.title : undefined,
    template: typeof form.template === "string" ? form.template : undefined,
    attendees: typeof form.attendees === "string" ? form.attendees : form.attendees,
    durationSeconds: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : undefined,
  };
}

export async function handleListNotes(c: Context) {
  const notes = await listAudioNotes();
  return c.json({ notes });
}

export async function handleGetNote(c: Context) {
  const id = c.req.param("id") ?? "";
  if (!id) return c.json({ error: "Note not found" }, 404);
  const note = await getAudioNote(id);
  if (!note) return c.json({ error: "Note not found" }, 404);
  return c.json({ note });
}

export async function handleGetJob(c: Context) {
  const jobId = c.req.param("jobId") ?? "";
  const job = getNoteJob(jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({ job });
}

export async function handleFromAudio(c: Context) {
  try {
    const input = await audioForm(c);
    const note = await createNoteFromAudio(input);
    return c.json({ note });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("required") ? 400 : 500;
    return c.json({ error: message }, status);
  }
}

export async function handleFromAudioAsync(c: Context) {
  try {
    const input = await audioForm(c);
    const { job, note } = await queueNoteFromAudio(input);
    return c.json({ job, note });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("required") ? 400 : 500;
    return c.json({ error: message }, status);
  }
}

export async function handleRetryDetails(c: Context) {
  try {
    const id = c.req.param("id") ?? "";
    const note = await retryNoteDetails(id);
    return c.json({ note });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, message.includes("not found") ? 404 : 500);
  }
}

export async function handleRetryTranscript(c: Context) {
  try {
    const id = c.req.param("id") ?? "";
    const job = await retryNoteTranscript(id);
    return c.json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, message.includes("not found") ? 404 : 500);
  }
}

export async function handleCreateUpload(c: Context) {
  try {
    const body = (await c.req.json()) as {
      filename?: string;
      mimeType?: string;
      byteLength?: number;
      contentHash?: string;
      title?: string;
      template?: string;
      attendees?: unknown;
      durationSeconds?: number;
    };
    const upload = await createNoteUpload({
      filename: body.filename || "recording.m4a",
      mimeType: body.mimeType,
      byteLength: Number(body.byteLength),
      contentHash: body.contentHash,
      title: body.title,
      template: body.template,
      attendees: body.attendees,
      durationSeconds: typeof body.durationSeconds === "number" ? body.durationSeconds : undefined,
    });
    return c.json({ upload });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /required|larger than/i.test(message) ? 400 : 500;
    return c.json({ error: message }, status);
  }
}

export async function handleGetUpload(c: Context) {
  const id = c.req.param("uploadId") ?? "";
  const upload = await getNoteUpload(id);
  if (!upload) return c.json({ error: "Upload not found" }, 404);
  return c.json({ upload });
}

export async function handlePutUploadChunk(c: Context) {
  try {
    const uploadId = c.req.param("uploadId") ?? "";
    const index = Number(c.req.param("index"));
    const body = (await c.req.json()) as { data?: string };
    if (!body.data || typeof body.data !== "string") {
      return c.json({ error: "data is required" }, 400);
    }
    const upload = await putNoteChunk({ id: uploadId, index, data: body.data });
    return c.json({ upload });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not found/i.test(message) ? 404 : /invalid|empty|expected/i.test(message) ? 400 : 500;
    return c.json({ error: message }, status);
  }
}

export async function handleCompleteUpload(c: Context) {
  try {
    const id = c.req.param("uploadId") ?? "";
    const upload = await requestCompleteNoteUpload(id);
    if (upload.status === "completed" && upload.noteId) {
      const note = await getAudioNote(upload.noteId);
      if (note) {
        return c.json({ upload, note, job: note.job ?? null });
      }
    }
    return c.json({ upload }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /not found/i.test(message) ? 404 : /incomplete/i.test(message) ? 409 : 500;
    return c.json({ error: message }, status);
  }
}

export async function handleAudio(c: Context) {
  const id = c.req.param("id") ?? "";
  const file = await readAudioNoteBytes(id);
  if (!file) return c.json({ error: "Audio not found" }, 404);
  const safeName = file.filename.replace(/[\r\n"]/g, "");
  return c.body(Uint8Array.from(file.bytes), 200, {
    "Content-Type": file.mimeType,
    "Content-Disposition": `inline; filename="${safeName}"`,
    "Cache-Control": "private, max-age=3600",
  });
}

export async function handleAudioMeta(c: Context) {
  const id = c.req.param("id") ?? "";
  const meta = await getNoteAudioMeta(id, NOTE_UPLOAD_CHUNK_BYTES);
  if (!meta) return c.json({ error: "Audio not found" }, 404);
  return c.json({ audio: { ...meta, chunkSize: NOTE_UPLOAD_CHUNK_BYTES } });
}

export async function handleAudioChunk(c: Context) {
  const id = c.req.param("id") ?? "";
  const index = Number(c.req.param("index"));
  try {
    const chunk = await getNoteAudioChunk(id, index, NOTE_UPLOAD_CHUNK_BYTES);
    if (!chunk) return c.json({ error: "Audio not found" }, 404);
    return c.json({ chunk });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, /invalid/i.test(message) ? 400 : 500);
  }
}
