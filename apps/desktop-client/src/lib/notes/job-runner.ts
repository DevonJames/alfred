import { readFile } from "node:fs/promises";
import {
  beginAudioNote,
  completeAudioNote,
  emptyAudioNoteMetadata,
  updateAudioNoteProgress,
  upsertAudioNoteFolderEntity,
  audioMimeFromFilename,
} from "@alfred/memory";
import { activeProfileId, oipForProfile } from "../oip-memory.js";
import { probeAudioDurationSeconds } from "./audio-chunks.js";
import { resolveFolderNoteNames } from "./filename-meta.js";
import { createNoteJob, getNoteJob, updateNoteJob } from "./jobs.js";
import { getAudioNote, listAudioNotes, readAudioNoteBytes } from "./service.js";
import { summarizeAudioNote } from "./summarization.js";
import { transcribeAudioNote } from "./stt.js";
import type { NoteWorkItem } from "./queue.js";

export interface NoteJobRunResult {
  yielded?: boolean;
  nextChunk?: number;
  transcript?: string;
  failed?: boolean;
  error?: string;
  noteId?: string;
  jobId?: string;
}

const running = new Set<string>();

export async function runNoteJob(
  item: NoteWorkItem,
  opts: { shouldYield?: () => boolean },
): Promise<NoteJobRunResult> {
  if (running.has(item.id)) return {};
  running.add(item.id);
  try {
    return await execute(item, opts);
  } finally {
    running.delete(item.id);
  }
}

async function execute(
  item: NoteWorkItem,
  opts: { shouldYield?: () => boolean },
): Promise<NoteJobRunResult> {
  let noteId = item.noteId;
  let jobId = item.jobId;
  let folderDid = item.folderDid;
  const profileId = item.profileId;

  if (!noteId) {
    if (!item.absPath) return { failed: true, error: "Folder item is missing a file path" };
    const bytes = await readFile(item.absPath);
    const mimeType = item.mimeType || audioMimeFromFilename(item.filename);
    const durationSeconds =
      item.durationSeconds ?? (await probeAudioDurationSeconds(bytes, item.filename)) ?? undefined;
    if (!folderDid && item.folderLabel?.trim()) {
      const provider = oipForProfile(profileId);
      folderDid = (await upsertAudioNoteFolderEntity(provider, item.folderLabel, new Date().toISOString())).id;
    }
    const started = await beginAudioNote({
      filename: item.filename,
      bytes,
      mimeType,
      title: item.title?.trim() || item.filename.replace(/\.[^.]+$/, ""),
      template: item.template,
      attendees: item.attendees,
      folderDid,
      durationSeconds,
      profileId: activeProfileId(profileId),
    });
    const job = createNoteJob(started.episodeId);
    noteId = started.episodeId;
    jobId = job.id;
  }

  if (!jobId) {
    const job = createNoteJob(noteId);
    jobId = job.id;
  }

  const { updateNoteWork } = await import("./queue.js");
  updateNoteWork(item.id, { noteId, jobId, folderDid });
  const { markFolderWorkStarted } = await import("./folders.js");
  await markFolderWorkStarted({ ...item, noteId, jobId });

  const job = getNoteJob(jobId);
  if (!job) return { failed: true, error: "Job missing", noteId, jobId };

  updateNoteJob(jobId, { status: "processing", progress: 8, message: "Preparing audio" });
  const existing = await getAudioNote(noteId, profileId).catch(() => null);
  let partialTranscript = item.partialTranscript?.trim() || existing?.transcript?.trim() || "";
  if (partialTranscript === "[Preparing audio…]" || partialTranscript === "[Transcribing audio chunks…]") {
    partialTranscript = "";
  }
  await updateAudioNoteProgress({
    episodeId: noteId,
    transcript: partialTranscript || "[Preparing audio…]",
    processingStatus: "processing",
    durationSeconds: item.durationSeconds ?? existing?.durationSeconds ?? undefined,
    profileId: activeProfileId(profileId),
  }).catch(() => undefined);

  try {
    const file =
      (await readAudioNoteBytes(noteId, profileId)) ??
      (item.absPath
        ? {
            bytes: await readFile(item.absPath),
            filename: item.filename,
            mimeType: item.mimeType,
          }
        : null);
    if (!file) throw new Error("Original audio is not available");
    updateNoteJob(jobId, { progress: 12, message: "Transcribing in 5-minute chunks" });
    const transcribed = await transcribeAudioNote({
      bytes: file.bytes,
      filename: file.filename,
      mimeType: file.mimeType,
      forceChunk: true,
      startChunk: item.nextChunk ?? 0,
      existingText: partialTranscript,
      shouldYield: opts.shouldYield,
      onProgress: async ({ chunkIndex, totalChunks, combinedText, durationSeconds }) => {
        partialTranscript = combinedText;
        const progress = Math.min(70, Math.round(12 + ((chunkIndex + 1) / totalChunks) * 55));
        updateNoteJob(jobId, {
          progress,
          message: `Transcribed chunk ${chunkIndex + 1} of ${totalChunks}`,
        });
        await updateAudioNoteProgress({
          episodeId: noteId!,
          transcript: combinedText || "[Transcribing audio chunks…]",
          processingStatus: "processing",
          durationSeconds: durationSeconds ?? item.durationSeconds,
          profileId: activeProfileId(profileId),
        }).catch(() => undefined);
      },
    });

    if (transcribed.yielded) {
      updateNoteJob(jobId, { progress: job.progress, message: "Paused for iPhone recording" });
      return {
        yielded: true,
        nextChunk: transcribed.nextChunk,
        transcript: transcribed.text,
        noteId,
        jobId,
      };
    }

    partialTranscript = transcribed.text;
    updateNoteJob(jobId, { progress: 75, message: "Summarizing" });
    const metadata = await summarizeAudioNote({
      text: transcribed.text,
      noteType: item.template,
      participants: item.attendees,
    });

    let title = item.title?.trim() || metadata.summary.slice(0, 80) || undefined;
    if (item.nameFromFolder) {
      const existingTitles = (await listAudioNotes(profileId).catch(() => [])).map((n) => n.title);
      const named = await resolveFolderNoteNames({
        filename: item.filename,
        summary: metadata.summary,
        existingTitles,
      });
      title = named.title;
      if (named.location) metadata.location = named.location;
      metadata.attendees = [...new Set([...named.participants, ...metadata.attendees, ...item.attendees])];
    } else {
      metadata.attendees = [...new Set([...item.attendees, ...metadata.attendees])];
    }

    updateNoteJob(jobId, { progress: 90, message: "Saving to memory" });
    await completeAudioNote({
      episodeId: noteId,
      transcript: transcribed.text,
      metadata,
      title,
      profileId: activeProfileId(profileId),
    });
    await oipForProfile(profileId).rebuildIndexes();
    updateNoteJob(jobId, { status: "completed", progress: 100, message: "Complete" });
    const { markFolderWorkResult } = await import("./folders.js");
    await markFolderWorkResult({ ...item, noteId, jobId }, "completed");
    return { noteId, jobId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateNoteJob(jobId, { status: "failed", error: message, message: "Failed" });
    const { markFolderWorkResult } = await import("./folders.js");
    await markFolderWorkResult({ ...item, noteId, jobId }, "failed", message);
    await completeAudioNote({
      episodeId: noteId,
      transcript: partialTranscript,
      metadata: emptyAudioNoteMetadata(item.template),
      processingStatus: "failed",
      writeObservations: false,
      profileId: activeProfileId(profileId),
    }).catch(() => undefined);
    return { failed: true, error: message, noteId, jobId };
  }
}
