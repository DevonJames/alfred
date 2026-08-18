import { defaultOipMemoryRoot, OipLocalMemoryProvider } from "../oip-local/index.js";
import { appendXIngestDigest, invalidateBriefingCacheFile } from "./digest.js";
import { loadXLedger, saveXLedger, upsertLedgerEntry, urlsToProcess } from "./ledger.js";
import {
  annotateFailureInNoteBody,
  appendArchiveLine,
  extractInboxUrls,
  readAppleNote,
  removeUrlFromNoteBody,
  writeAppleNote,
  type NotesRunner,
} from "./notes.js";
import { writeXCaptureToOip } from "./oip-write.js";
import { ingestDayKey } from "./paths.js";
import { findXSource, loadXSources } from "./sources.js";
import type {
  XCaptureAdapter,
  XIngestItemResult,
  XIngestRunResult,
  XSource,
} from "./types.js";
import { canonicalizeXUrl } from "./urls.js";

function summarizeCapture(text: string, headline: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 420) return trimmed || headline;
  return `${trimmed.slice(0, 400).trim()}…`;
}

export async function ingestXUrl(opts: {
  url: string;
  profileId?: string;
  capture: XCaptureAdapter;
  noteName?: string;
  noteFolder?: string;
  provider?: OipLocalMemoryProvider;
  now?: Date;
}): Promise<XIngestItemResult> {
  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? new OipLocalMemoryProvider(defaultOipMemoryRoot(profileId));
  const sources: XSource[] = opts.noteName
    ? [
        {
          id: "adhoc",
          folder: opts.noteFolder ?? "",
          note: opts.noteName,
          archiveNote: `${opts.noteName} Ingested`,
        },
      ]
    : [];
  const result = await ingestOneUrl({
    url: opts.url,
    profileId,
    capture: opts.capture,
    provider,
    sources,
    now,
  });
  if (result.status !== "skipped") {
    await appendXIngestDigest(
      profileId,
      ingestDayKey(now),
      [
        {
          url: result.url,
          canonicalUrl: result.canonicalUrl,
          noteName: result.noteName,
          headline: result.headline ?? result.url,
          author: result.author,
          kind: result.kind,
          status: result.status === "ingested" ? "ingested" : "failed",
          error: result.error,
          summary: result.summary,
        },
      ],
      now,
    );
    await invalidateBriefingCacheFile(profileId, ingestDayKey(now));
  }
  return result;
}

export async function ingestXNotes(opts: {
  profileId?: string;
  note?: string;
  capture: XCaptureAdapter;
  notesRunner?: NotesRunner;
  provider?: OipLocalMemoryProvider;
  now?: Date;
  dryRun?: boolean;
}): Promise<XIngestRunResult> {
  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const now = opts.now ?? new Date();
  const sources = await loadXSources(profileId);
  const selected = opts.note ? findXSource(sources, opts.note) : undefined;
  if (opts.note && !selected) {
    throw new Error(`No registered X ingest note matching "${opts.note}"`);
  }
  const active = selected ? [selected] : sources;
  if (!active.length) {
    throw new Error(
      'No X ingest notes registered. Run: pnpm memory -- ingest-x-source add --folder "…" --note "…"',
    );
  }

  const provider = opts.provider ?? new OipLocalMemoryProvider(defaultOipMemoryRoot(profileId));
  const processed: XIngestItemResult[] = [];

  for (const source of active) {
    const note = await readAppleNote(source.folder, source.note, opts.notesRunner);
    const urls = extractInboxUrls(note.body);
    const ledger = await loadXLedger(profileId);
    const todo = urlsToProcess(urls, ledger);

    let body = note.body;
    let archiveBody: string | undefined;

    for (const item of todo) {
      if (opts.dryRun) {
        processed.push({
          url: item.url,
          canonicalUrl: item.canonicalUrl,
          noteName: source.note,
          noteFolder: source.folder,
          status: "skipped",
          headline: item.entry?.headline,
        });
        continue;
      }

      upsertLedgerEntry(ledger, {
        url: item.url,
        canonicalUrl: item.canonicalUrl,
        status: "in_progress",
        noteNames: [source.note],
        noteFolders: [source.folder],
      });
      await saveXLedger(profileId, ledger);

      const result = await ingestOneUrl({
        url: item.url,
        profileId,
        capture: opts.capture,
        provider,
        sources: [source],
        now,
      });
      processed.push(result);

      if (result.status === "ingested") {
        body = removeUrlFromNoteBody(body, item.url);
        if (!archiveBody) {
          try {
            archiveBody = (await readAppleNote(source.folder, source.archiveNote, opts.notesRunner))
              .body;
          } catch {
            archiveBody = "";
          }
        }
        archiveBody = appendArchiveLine(archiveBody, {
          date: now.toISOString().slice(0, 10),
          author: result.author,
          headline: result.headline ?? result.canonicalUrl,
          url: item.url,
        });
      } else if (result.status === "failed") {
        body = annotateFailureInNoteBody(body, item.url, result.error ?? "unknown error");
      }
    }

    if (!opts.dryRun) {
      await writeAppleNote(source.folder, source.note, body, opts.notesRunner);
      if (archiveBody != null) {
        await writeAppleNote(source.folder, source.archiveNote, archiveBody, opts.notesRunner);
      }
    }
  }

  const digestItems = processed
    .filter((p) => p.status === "ingested" || p.status === "failed")
    .map((p) => ({
      url: p.url,
      canonicalUrl: p.canonicalUrl,
      noteName: p.noteName,
      headline: p.headline ?? p.url,
      author: p.author,
      kind: p.kind,
      status: p.status === "ingested" ? ("ingested" as const) : ("failed" as const),
      error: p.error,
      summary: p.summary,
    }));
  if (digestItems.length && !opts.dryRun) {
    await appendXIngestDigest(profileId, ingestDayKey(now), digestItems, now);
    await invalidateBriefingCacheFile(profileId, ingestDayKey(now));
  }

  return { processed, sources: active };
}

async function ingestOneUrl(opts: {
  url: string;
  profileId: string;
  capture: XCaptureAdapter;
  provider: OipLocalMemoryProvider;
  sources: XSource[];
  now: Date;
}): Promise<XIngestItemResult> {
  const canonicalUrl = canonicalizeXUrl(opts.url);
  const noteName = opts.sources[0]?.note;
  const noteFolder = opts.sources[0]?.folder;
  const ledger = await loadXLedger(opts.profileId);
  try {
    const capture = await opts.capture.capture(opts.url);
    if (capture.failure) {
      upsertLedgerEntry(ledger, {
        url: opts.url,
        canonicalUrl,
        status: "failed",
        noteNames: noteName ? [noteName] : [],
        noteFolders: noteFolder ? [noteFolder] : [],
        error: capture.failure.reason,
        errorHeadline: capture.failure.headline ?? capture.headline,
        headline: capture.headline || capture.failure.headline,
        kind: capture.kind,
      });
      await saveXLedger(opts.profileId, ledger);
      return {
        url: opts.url,
        canonicalUrl,
        noteName,
        noteFolder,
        status: "failed",
        kind: capture.kind,
        headline: capture.headline || capture.failure.headline,
        author: capture.author,
        error: capture.failure.reason,
      };
    }

    const written = await writeXCaptureToOip({
      provider: opts.provider,
      capture,
      sources: opts.sources,
      learnedAt: opts.now.toISOString(),
    });
    upsertLedgerEntry(ledger, {
      url: opts.url,
      canonicalUrl: capture.canonicalUrl || canonicalUrl,
      status: "ingested",
      kind: capture.kind,
      headline: capture.headline,
      author: capture.author,
      authorHandle: capture.authorHandle,
      noteNames: noteName ? [noteName] : [],
      noteFolders: noteFolder ? [noteFolder] : [],
      contentHash: written.contentHash,
      lastIngestedAt: opts.now.toISOString(),
      memoryDid: written.memoryDid,
      error: undefined,
    });
    await saveXLedger(opts.profileId, ledger);
    return {
      url: opts.url,
      canonicalUrl: capture.canonicalUrl || canonicalUrl,
      noteName,
      noteFolder,
      status: "ingested",
      kind: capture.kind,
      headline: capture.headline,
      author: capture.author,
      memoryDid: written.memoryDid,
      summary: summarizeCapture(capture.text, capture.headline),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    upsertLedgerEntry(ledger, {
      url: opts.url,
      canonicalUrl,
      status: "failed",
      noteNames: noteName ? [noteName] : [],
      noteFolders: noteFolder ? [noteFolder] : [],
      error: message,
    });
    await saveXLedger(opts.profileId, ledger);
    return {
      url: opts.url,
      canonicalUrl,
      noteName,
      noteFolder,
      status: "failed",
      error: message,
    };
  }
}
