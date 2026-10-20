import { speechFromRun } from "@alfred/agents";
import { getSharedPlaywrightCaptureAdapter } from "@alfred/browser";
import {
  addXSource,
  composeNotesCaptureAdapter,
  ingestXNotes,
  loadXLedger,
  loadXSources,
  removeXSource,
  type XCaptureAdapter,
  type XIngestProgress,
  type XIngestRunResult,
  type XSource,
} from "@alfred/memory";
import { activeProfileId } from "./oip-memory.js";

export interface NotesIngestSourceRow {
  id: string;
  folder: string;
  note: string;
  archiveNote: string;
  trackedLinks: number;
  lastIngestedAt?: string;
}

export interface NotesIngestSchedule {
  time: string;
  timezone: string;
  label: string;
}

export interface NotesIngestSourceList {
  schedule: NotesIngestSchedule;
  sources: NotesIngestSourceRow[];
}

export function notesIngestSchedule(): NotesIngestSchedule {
  const timezone = process.env.BRIEFING_TIMEZONE ?? "America/Los_Angeles";
  const time = process.env.ALFRED_X_INGEST_SCHEDULE?.trim() || "06:00";
  return { time, timezone, label: `daily at ${time} (${timezone})` };
}

export async function listNotesIngestSources(
  profileId = activeProfileId(),
): Promise<NotesIngestSourceList> {
  const sources = await loadXSources(profileId);
  const ledger = await loadXLedger(profileId);
  return {
    schedule: notesIngestSchedule(),
    sources: sources.map((source) => rowForSource(source, ledger)),
  };
}

function rowForSource(
  source: XSource,
  ledger: Map<string, { noteNames?: string[]; lastIngestedAt?: string }>,
): NotesIngestSourceRow {
  const note = source.note.toLowerCase();
  let trackedLinks = 0;
  let lastIngestedAt: string | undefined;
  for (const entry of ledger.values()) {
    const names = (entry.noteNames ?? []).map((n) => n.toLowerCase());
    if (!names.includes(note)) continue;
    trackedLinks += 1;
    if (entry.lastIngestedAt && (!lastIngestedAt || entry.lastIngestedAt > lastIngestedAt)) {
      lastIngestedAt = entry.lastIngestedAt;
    }
  }
  return {
    id: source.id,
    folder: source.folder,
    note: source.note,
    archiveNote: source.archiveNote,
    trackedLinks,
    lastIngestedAt,
  };
}

export async function addNotesIngestSource(opts: {
  folder: string;
  note: string;
  archiveNote?: string;
  profileId?: string;
}): Promise<{ source: XSource; sources: NotesIngestSourceRow[]; schedule: NotesIngestSchedule }> {
  const folder = opts.folder.trim();
  const note = opts.note.trim();
  if (!folder) throw new Error("Notes folder is required");
  if (!note) throw new Error("Note title is required");
  const profileId = opts.profileId ?? activeProfileId();
  const source = await addXSource(profileId, {
    folder,
    note,
    archiveNote: opts.archiveNote?.trim() || undefined,
  });
  const listed = await listNotesIngestSources(profileId);
  return { source, sources: listed.sources, schedule: listed.schedule };
}

export async function removeNotesIngestSource(
  idOrNote: string,
  profileId = activeProfileId(),
): Promise<{ removed: XSource; sources: NotesIngestSourceRow[]; schedule: NotesIngestSchedule }> {
  const key = idOrNote.trim();
  if (!key) throw new Error("Note id is required");
  const removed = await removeXSource(profileId, key);
  if (!removed) throw new Error(`No Apple Notes inbox matching "${key}"`);
  const listed = await listNotesIngestSources(profileId);
  return { removed, sources: listed.sources, schedule: listed.schedule };
}

export async function scanNotesIngestSource(
  idOrNote: string,
  opts?: {
    profileId?: string;
    capture?: XCaptureAdapter;
    onProgress?: (progress: XIngestProgress) => void | Promise<void>;
  },
): Promise<{
  run: XIngestRunResult & { speech: string };
  sources: NotesIngestSourceRow[];
  schedule: NotesIngestSchedule;
}> {
  const key = idOrNote.trim();
  if (!key) throw new Error("Note id is required");
  const profileId = opts?.profileId ?? activeProfileId();
  const capture = opts?.capture ?? composeNotesCaptureAdapter(getSharedPlaywrightCaptureAdapter());
  try {
    const run = await ingestXNotes({
      profileId,
      note: key,
      capture,
      onProgress: opts?.onProgress,
    });
    const listed = await listNotesIngestSources(profileId);
    return { run: { ...run, speech: speechFromRun(run) }, sources: listed.sources, schedule: listed.schedule };
  } finally {
    if (!opts?.capture) await capture.close?.();
  }
}
