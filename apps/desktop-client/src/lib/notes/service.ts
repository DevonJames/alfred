import { open, readFile, stat } from "node:fs/promises";
import {
  audioMimeFromFilename,
  audioNoteFromEpisode,
  beginAudioNote,
  completeAudioNote,
  ingestAudioNote,
  isAudioNoteEpisode,
  updateAudioNoteProgress,
  type AudioNoteMetadata,
  type AudioNoteTemplate,
  type TaggedHash,
} from "@alfred/memory";
import { activeProfileId, oipForProfile } from "../oip-memory.js";
import { probeAudioDurationSeconds } from "./audio-chunks.js";
import { createNoteJob, latestJobForNote, listNoteJobs, updateNoteJob, type NoteJob } from "./jobs.js";
import { summarizeAudioNote } from "./summarization.js";
import { transcribeAudioNote } from "./stt.js";

export interface NoteAttendee {
  name: string;
}

export interface AudioNoteDto {
  id: string;
  title: string;
  template: AudioNoteTemplate;
  processingStatus: "processing" | "completed" | "failed";
  summary: string;
  takeaways: string[];
  nextSteps: Array<{ text: string; assignee?: string; dueDate?: string }>;
  openQuestions: string[];
  attendees: NoteAttendee[];
  location: string | null;
  transcript: string;
  audioUrl: string;
  artifactId: string | null;
  fileEntityId: string | null;
  episodeId: string;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  jobId?: string;
  job?: NoteJob | null;
}

function attendeesFromForm(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return attendeesFromForm(parsed);
    } catch {
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && "name" in item) {
          return String((item as { name: unknown }).name).trim();
        }
        return "";
      })
      .filter(Boolean);
  }
  return [];
}

function templateFromForm(raw: unknown): AudioNoteTemplate {
  const value = String(raw ?? "freeform").toLowerCase();
  if (value === "meeting" || value === "brainstorm" || value === "checkin" || value === "freeform") {
    return value;
  }
  return "freeform";
}

function toDto(
  note: ReturnType<typeof audioNoteFromEpisode>,
  opts?: { jobId?: string; job?: NoteJob | null },
): AudioNoteDto {
  const job = opts?.job ?? latestJobForNote(note.id);
  return {
    id: note.id,
    title: note.title,
    template: note.template,
    processingStatus: note.processingStatus,
    summary: note.summary,
    takeaways: note.takeaways,
    nextSteps: note.nextSteps,
    openQuestions: note.openQuestions,
    attendees: note.attendees.map((name) => ({ name })),
    location: note.location,
    transcript: note.transcript,
    audioUrl: `/api/notes/${encodeURIComponent(note.id)}/audio`,
    artifactId: note.artifactId,
    fileEntityId: note.fileEntityId,
    episodeId: note.id,
    durationSeconds: note.durationSeconds,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    jobId: opts?.jobId ?? job?.id,
    job,
  };
}

export async function listAudioNotes(profileId?: string): Promise<AudioNoteDto[]> {
  const memory = oipForProfile(profileId);
  await memory.packages.ensureRoot();
  memory.sqlite.open();
  const seen = new Set<string>();
  const rows = [
    ...memory.sqlite.findBySearchSubstring("audio_note", 2000),
    ...memory.sqlite.listByType("Episode", 2000),
  ];
  const notes: AudioNoteDto[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const rev = await memory.resolveRef(row.id);
    if (!isAudioNoteEpisode(rev)) continue;
    notes.push(toDto(audioNoteFromEpisode(rev)));
  }
  notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return notes;
}

export async function getAudioNote(id: string, profileId?: string): Promise<AudioNoteDto | null> {
  const memory = oipForProfile(profileId);
  const rev = await memory.resolveRef(id);
  if (!isAudioNoteEpisode(rev)) return null;
  return toDto(audioNoteFromEpisode(rev));
}

export async function locateAudioNoteFile(
  id: string,
  profileId?: string,
): Promise<{ path: string; mimeType: string; filename: string; byteLength: number } | null> {
  const memory = oipForProfile(profileId);
  const rev = await memory.resolveRef(id);
  if (!rev) return null;
  const artifactId =
    (typeof rev.drefs?.sourceArtifact === "string" && rev.drefs.sourceArtifact) ||
    (rev.type === "Artifact" ? rev.id : null);
  if (!artifactId) return null;
  const artifact = (await memory.resolveRef(artifactId)) ?? (rev.type === "Artifact" ? rev : null);
  if (!artifact?.contentHash) return null;
  const absolute = await memory.artifacts.findAbsolute(artifact.contentHash as TaggedHash);
  if (!absolute) return null;
  const info = await stat(absolute);
  return {
    path: absolute,
    mimeType: artifact.mimeType || audioMimeFromFilename(artifact.originalFilename || "recording.m4a"),
    filename: artifact.originalFilename || artifact.name || "recording.m4a",
    byteLength: info.size,
  };
}

export async function readAudioNoteBytes(
  id: string,
  profileId?: string,
): Promise<{ bytes: Buffer; mimeType: string; filename: string } | null> {
  const file = await locateAudioNoteFile(id, profileId);
  if (!file) return null;
  return {
    bytes: await readFile(file.path),
    mimeType: file.mimeType,
    filename: file.filename,
  };
}

export async function getNoteAudioMeta(
  id: string,
  chunkSize: number,
  profileId?: string,
): Promise<{ filename: string; mimeType: string; byteLength: number; totalChunks: number } | null> {
  const file = await locateAudioNoteFile(id, profileId);
  if (!file) return null;
  return {
    filename: file.filename,
    mimeType: file.mimeType,
    byteLength: file.byteLength,
    totalChunks: Math.max(1, Math.ceil(file.byteLength / chunkSize)),
  };
}

export async function getNoteAudioChunk(
  id: string,
  index: number,
  chunkSize: number,
  profileId?: string,
): Promise<{ index: number; data: string; totalChunks: number; byteLength: number } | null> {
  const file = await locateAudioNoteFile(id, profileId);
  if (!file) return null;
  const totalChunks = Math.max(1, Math.ceil(file.byteLength / chunkSize));
  if (!Number.isInteger(index) || index < 0 || index >= totalChunks) {
    throw new Error("Invalid chunk index");
  }
  const start = index * chunkSize;
  const length = Math.min(chunkSize, file.byteLength - start);
  const handle = await open(file.path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const read = await handle.read(bytes, 0, length, start);
    return {
      index,
      data: bytes.subarray(0, read.bytesRead).toString("base64"),
      totalChunks,
      byteLength: file.byteLength,
    };
  } finally {
    await handle.close();
  }
}

async function summarizeFromTranscript(opts: {
  transcript: string;
  template: AudioNoteTemplate;
  attendees: string[];
}): Promise<AudioNoteMetadata> {
  const metadata = await summarizeAudioNote({
    text: opts.transcript,
    noteType: opts.template,
    participants: opts.attendees,
  });
  if (!metadata.attendees.length && opts.attendees.length) {
    metadata.attendees = opts.attendees;
  }
  if (metadata.template === "freeform" && opts.template !== "freeform") {
    metadata.template = opts.template;
  }
  return metadata;
}

export async function createNoteFromAudio(opts: {
  bytes: Buffer;
  filename: string;
  mimeType?: string;
  title?: string;
  template?: string;
  attendees?: unknown;
  durationSeconds?: number;
  profileId?: string;
}): Promise<AudioNoteDto> {
  const template = templateFromForm(opts.template);
  const attendees = attendeesFromForm(opts.attendees);
  const mimeType = audioMimeFromFilename(opts.filename, opts.mimeType);
  const transcribed = await transcribeAudioNote({
    bytes: opts.bytes,
    filename: opts.filename,
    mimeType,
  });
  const metadata = await summarizeFromTranscript({
    transcript: transcribed.text,
    template,
    attendees,
  });
  const title = opts.title?.trim() || metadata.summary.slice(0, 80) || opts.filename.replace(/\.[^.]+$/, "");
  const result = await ingestAudioNote({
    filename: opts.filename,
    bytes: opts.bytes,
    mimeType,
    title,
    transcript: transcribed.text,
    metadata,
    durationSeconds: opts.durationSeconds ?? transcribed.durationSeconds ?? undefined,
    profileId: activeProfileId(opts.profileId),
  });
  await oipForProfile(opts.profileId).rebuildIndexes();
  const note = await getAudioNote(result.episodeId, opts.profileId);
  if (!note) throw new Error("Note ingest succeeded but the episode could not be read");
  return note;
}

export async function queueNoteFromAudio(opts: {
  bytes: Buffer;
  filename: string;
  mimeType?: string;
  title?: string;
  template?: string;
  attendees?: unknown;
  durationSeconds?: number;
  profileId?: string;
}): Promise<{ job: NoteJob; note: AudioNoteDto }> {
  const template = templateFromForm(opts.template);
  const attendees = attendeesFromForm(opts.attendees);
  const mimeType = audioMimeFromFilename(opts.filename, opts.mimeType);
  const durationSeconds =
    opts.durationSeconds ?? (await probeAudioDurationSeconds(opts.bytes, opts.filename)) ?? undefined;
  const started = await beginAudioNote({
    filename: opts.filename,
    bytes: opts.bytes,
    mimeType,
    title: opts.title?.trim() || opts.filename.replace(/\.[^.]+$/, ""),
    template,
    attendees,
    durationSeconds,
    profileId: activeProfileId(opts.profileId),
  });
  await oipForProfile(opts.profileId).rebuildIndexes();
  const job = createNoteJob(started.episodeId);
  const note = await getAudioNote(started.episodeId, opts.profileId);
  if (!note) throw new Error("Note stub was not created");
  const { enqueueNoteWork } = await import("./queue.js");
  enqueueNoteWork({
    priority: "interactive",
    source: "ui",
    noteId: started.episodeId,
    jobId: job.id,
    filename: opts.filename,
    mimeType,
    title: opts.title,
    template,
    attendees,
    durationSeconds,
    profileId: opts.profileId,
  });
  return { job, note: { ...note, jobId: job.id } };
}

export async function resumeInterruptedNoteJobs(profileId?: string): Promise<void> {
  const { enqueueNoteWork, listNoteWork, loadNoteQueue, pumpNoteWorker } = await import("./queue.js");
  await loadNoteQueue();
  const already = new Set(listNoteWork().map((item) => item.jobId).filter(Boolean));
  const interrupted = listNoteJobs().filter((job) => job.status === "queued" || job.status === "processing");
  for (const job of interrupted) {
    if (already.has(job.id)) continue;
    const current = await getAudioNote(job.noteId, profileId).catch(() => null);
    const file = await readAudioNoteBytes(job.noteId, profileId).catch(() => null);
    if (!current || !file) {
      updateNoteJob(job.id, {
        status: "failed",
        error: "Audio missing after restart",
        message: "Failed",
      });
      continue;
    }
    console.log(`[notes] Resuming ${job.status} job ${job.id} for ${current.title}`);
    enqueueNoteWork({
      priority: "interactive",
      source: "resume",
      noteId: job.noteId,
      jobId: job.id,
      filename: file.filename,
      mimeType: file.mimeType,
      title: current.title,
      template: current.template,
      attendees: current.attendees.map((a) => a.name),
      durationSeconds: current.durationSeconds ?? undefined,
      profileId,
    });
  }
  await pumpNoteWorker();
}

export async function retryNoteDetails(id: string, profileId?: string): Promise<AudioNoteDto> {
  const current = await getAudioNote(id, profileId);
  if (!current) throw new Error("Note not found");
  if (!current.transcript.trim()) throw new Error("Note has no transcript to summarize");
  const metadata = await summarizeFromTranscript({
    transcript: current.transcript,
    template: current.template,
    attendees: current.attendees.map((a) => a.name),
  });
  await completeAudioNote({
    episodeId: id,
    transcript: current.transcript,
    metadata,
    title: current.title,
    writeObservations: false,
    profileId: activeProfileId(profileId),
  });
  await oipForProfile(profileId).rebuildIndexes();
  const next = await getAudioNote(id, profileId);
  if (!next) throw new Error("Note disappeared after retry");
  return next;
}

export async function retryNoteTranscript(id: string, profileId?: string): Promise<NoteJob> {
  const current = await getAudioNote(id, profileId);
  if (!current) throw new Error("Note not found");
  const file = await readAudioNoteBytes(id, profileId);
  if (!file) throw new Error("Original audio is not available");
  await updateAudioNoteProgress({
    episodeId: id,
    transcript: current.transcript || "[Retrying transcription…]",
    processingStatus: "processing",
    durationSeconds: current.durationSeconds ?? undefined,
    profileId: activeProfileId(profileId),
  }).catch(() => undefined);
  const job = createNoteJob(id);
  const { enqueueNoteWork } = await import("./queue.js");
  enqueueNoteWork({
    priority: "interactive",
    source: "retry",
    noteId: id,
    jobId: job.id,
    filename: file.filename,
    mimeType: file.mimeType,
    title: current.title,
    template: current.template,
    attendees: current.attendees.map((a) => a.name),
    durationSeconds: current.durationSeconds ?? undefined,
    profileId,
  });
  return job;
}
