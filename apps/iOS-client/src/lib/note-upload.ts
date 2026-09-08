/**
 * Resumable audio-note upload for the alfrd.net relay.
 *
 * The hub forwards each HTTP request as one JSON WebSocket message and waits
 * 30s. A 2-hour m4a cannot take that hop whole, so we send 256 KB base64
 * slices and resume from the indexes the Mac already has.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import { create } from "zustand";
import { isRelayUrl, useConnection } from "./connection";
import {
  completeNoteUploadSession,
  createAudioNoteFromFile,
  createNoteUploadSession,
  getAudioNote,
  getNoteUploadSession,
  putNoteUploadChunk,
} from "./desktop-api";
import type { AudioNote, AudioNoteJob, AudioNoteTemplate } from "./types";

const STORAGE_KEY = "alfred_note_upload";
const LAN_SINGLE_POST_MAX = 8 * 1024 * 1024;

export interface NoteUploadInput {
  uri: string;
  filename?: string;
  mimeType?: string;
  title?: string;
  template?: AudioNoteTemplate;
  attendees?: string[];
  durationSeconds?: number;
  durationMode: "short" | "long";
}

export interface NoteUploadProgress {
  uploadId: string;
  filename: string;
  received: number;
  totalChunks: number;
  status: "uploading" | "completing" | "done" | "error";
  message: string;
  error?: string;
  noteId?: string;
}

interface PersistedUpload extends NoteUploadInput {
  uploadId: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  chunkSize: number;
  totalChunks: number;
}

interface NoteUploadState {
  current: NoteUploadProgress | null;
  running: boolean;
  hydrate: () => Promise<void>;
  begin: (input: NoteUploadInput) => Promise<{ noteId?: string; deferred: boolean }>;
  resume: () => Promise<void>;
  clear: () => Promise<void>;
}

async function persist(session: PersistedUpload | null): Promise<void> {
  if (!session) {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

async function loadPersisted(): Promise<PersistedUpload | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedUpload) : null;
  } catch {
    return null;
  }
}

async function fileSize(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists || info.isDirectory || typeof info.size !== "number") {
    throw new Error("Recording file is missing on this phone.");
  }
  return info.size;
}

export function shouldChunkNoteUpload(byteLength: number, serverUrl = useConnection.getState().serverUrl): boolean {
  if (!serverUrl) return true;
  if (isRelayUrl(serverUrl)) return true;
  return byteLength > LAN_SINGLE_POST_MAX;
}

let inFlight: Promise<void> | null = null;
let persisted: PersistedUpload | null = null;

async function sendMissingChunks(
  session: PersistedUpload,
  onProgress: (patch: Partial<NoteUploadProgress>) => void,
): Promise<void> {
  let remote = await getNoteUploadSession(session.uploadId);
  const received = new Set(remote.received);
  for (let index = 0; index < session.totalChunks; index += 1) {
    if (received.has(index)) continue;
    const position = index * session.chunkSize;
    const length = Math.min(session.chunkSize, session.byteLength - position);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const data = await FileSystem.readAsStringAsync(session.uri, {
          encoding: FileSystem.EncodingType.Base64,
          position,
          length,
        });
        remote = await putNoteUploadChunk(session.uploadId, index, data);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;
    received.clear();
    for (const item of remote.received) received.add(item);
    onProgress({
      received: remote.received.length,
      totalChunks: remote.totalChunks,
      status: "uploading",
      message: `Uploading ${remote.received.length} / ${remote.totalChunks}`,
    });
  }
}

async function runPersisted(
  session: PersistedUpload,
  set: (patch: Partial<NoteUploadState> | ((state: NoteUploadState) => Partial<NoteUploadState>)) => void,
): Promise<string> {
  const update = (patch: Partial<NoteUploadProgress>) => {
    set((state) => ({
      current: state.current ? { ...state.current, ...patch } : null,
    }));
  };
  update({
    uploadId: session.uploadId,
    filename: session.filename,
    received: 0,
    totalChunks: session.totalChunks,
    status: "uploading",
    message: `Uploading 0 / ${session.totalChunks}`,
  });
  await sendMissingChunks(session, update);
  update({ status: "completing", message: "Finishing upload" });
  const noteId = await finishUpload(session, update);
  await persist(null);
  persisted = null;
  update({
    status: "done",
    noteId,
    received: session.totalChunks,
    totalChunks: session.totalChunks,
    message: "Uploaded",
  });
  return noteId;
}

async function finishUpload(
  session: PersistedUpload,
  onProgress: (patch: Partial<NoteUploadProgress>) => void,
): Promise<string> {
  const deadline = Date.now() + 15 * 60 * 1000;
  let posted = false;
  while (Date.now() < deadline) {
    const remote = await getNoteUploadSession(session.uploadId).catch(() => null);
    if (remote?.status === "completed" && remote.noteId) {
      await getAudioNote(remote.noteId).catch(() => null);
      return remote.noteId;
    }
    if (remote?.status === "failed") {
      throw new Error(remote.error || "The Mac could not assemble that recording.");
    }
    if (!posted || remote?.status === "uploading") {
      try {
        const finished = await completeNoteUploadSession(session.uploadId);
        posted = true;
        if (finished.note?.id) return finished.note.id;
        if (finished.upload.status === "completed" && finished.upload.noteId) {
          return finished.upload.noteId;
        }
        onProgress({ status: "completing", message: "Saving recording on your Mac" });
      } catch {
        posted = true;
        onProgress({
          status: "completing",
          message: "Waiting for your Mac to finish saving…",
        });
      }
    } else {
      onProgress({ status: "completing", message: "Saving recording on your Mac" });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Your Mac is still saving that recording. Keep the Notes tab open and it will retry.");
}

export const useNoteUpload = create<NoteUploadState>((set, get) => ({
  current: null,
  running: false,

  hydrate: async () => {
    persisted = await loadPersisted();
    if (!persisted) return;
    set({
      current: {
        uploadId: persisted.uploadId,
        filename: persisted.filename,
        received: 0,
        totalChunks: persisted.totalChunks,
        status: "uploading",
        message: "Resuming upload…",
      },
    });
    if (useConnection.getState().serverUrl) {
      void get().resume();
    }
  },

  begin: async (input) => {
    const filename = input.filename ?? "recording.m4a";
    const mimeType = input.mimeType ?? "audio/mp4";
    const byteLength = await fileSize(input.uri);
    if (!shouldChunkNoteUpload(byteLength)) {
      const result = await createAudioNoteFromFile({
        uri: input.uri,
        filename,
        mimeType,
        title: input.title,
        template: input.template,
        attendees: input.attendees,
        durationSeconds: input.durationSeconds,
        durationMode: input.durationMode,
      });
      const noteId = result.note?.id ?? result.job?.noteId;
      return { noteId, deferred: false };
    }

    const created = await createNoteUploadSession({
      filename,
      mimeType,
      byteLength,
      title: input.title,
      template: input.template,
      attendees: input.attendees,
      durationSeconds: input.durationSeconds,
    });
    persisted = {
      ...input,
      uploadId: created.id,
      filename,
      mimeType,
      byteLength,
      chunkSize: created.chunkSize,
      totalChunks: created.totalChunks,
    };
    await persist(persisted);
    set({
      current: {
        uploadId: created.id,
        filename,
        received: created.received.length,
        totalChunks: created.totalChunks,
        status: "uploading",
        message: `Uploading ${created.received.length} / ${created.totalChunks}`,
      },
    });
    void get().resume();
    return { deferred: true };
  },

  resume: async () => {
    if (get().running || !persisted) return;
    if (inFlight) return inFlight;
    set({ running: true });
    inFlight = (async () => {
      try {
        await runPersisted(persisted!, set);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((state) => ({
          current: state.current
            ? { ...state.current, status: "error", error: message, message: "Upload paused" }
            : null,
        }));
      } finally {
        inFlight = null;
        set({ running: false });
      }
    })();
    return inFlight;
  },

  clear: async () => {
    persisted = null;
    await persist(null);
    set({ current: null, running: false });
  },
}));

export function watchConnectionForNoteUpload(): () => void {
  return useConnection.subscribe((state, previous) => {
    const cameOnline = previous.mode === "offline" && state.mode !== "offline";
    if (cameOnline && persisted) {
      useNoteUpload.getState().resume().catch(() => undefined);
    }
  });
}

