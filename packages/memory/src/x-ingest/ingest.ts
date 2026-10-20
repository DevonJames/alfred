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
import { sanitizeXIngestError } from "./errors.js";
import { writeNoteInboxBrief, type NoteBriefWriter } from "./note-brief.js";
import { writeXCaptureToOip } from "./oip-write.js";
import { ingestDayKey } from "./paths.js";
import { findXSource, loadXSources } from "./sources.js";
import type {
  XBrowserSession,
  XCaptureAdapter,
  XIngestItemResult,
  XIngestProgress,
  XIngestRunResult,
  XLedgerEntry,
  XSource,
} from "./types.js";
import { canonicalizeInboxUrl, isXUrl, isYouTubeUrl } from "./urls.js";

const X_BROWSER_STORM_LIMIT = 5;

/** Session/browser failures that will also hit every remaining X link. */
export function isXBrowserStormFailure(error: string | undefined): boolean {
  return /not logged|login wall|refused to load the post|closed mid-scan|has been closed|Target closed|could not be loaded|ingest browser is busy|profile is already in use|could not find that post|empty capture|different conversation|tweet cards never appeared|truncated/i.test(
    error ?? "",
  );
}

type SessionCache = { value?: XBrowserSession | false };

async function xSessionForRun(
  capture: XCaptureAdapter,
  cache: SessionCache,
): Promise<XBrowserSession | undefined> {
  if (cache.value === false) return undefined;
  if (cache.value) return cache.value;
  if (!capture.probeSession) {
    cache.value = false;
    return undefined;
  }
  try {
    cache.value = await capture.probeSession();
  } catch (err) {
    cache.value = {
      loggedIn: false,
      hint: sanitizeXIngestError(err instanceof Error ? err.message : String(err)),
    };
  }
  return cache.value;
}

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
  includeTranscript?: boolean;
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
  const sessionCache: SessionCache = {};
  try {
    const result = await ingestOneUrl({
      url: opts.url,
      profileId,
      capture: opts.capture,
      provider,
      sources,
      now,
      includeTranscript: opts.includeTranscript,
      sessionCache,
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
  } finally {
    await opts.capture.close?.();
  }
}

function ingestChunkSize(override?: number): number {
  const n = override ?? Number(process.env.ALFRED_X_INGEST_CHUNK ?? 20);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

function ingestChunkPauseMs(override?: number): number {
  const n = override ?? Number(process.env.ALFRED_X_INGEST_CHUNK_PAUSE_MS ?? 20_000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20_000;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ingestXNotes(opts: {
  profileId?: string;
  note?: string;
  capture: XCaptureAdapter;
  notesRunner?: NotesRunner;
  provider?: OipLocalMemoryProvider;
  now?: Date;
  dryRun?: boolean;
  briefWriter?: NoteBriefWriter;
  onProgress?: (progress: XIngestProgress) => void | Promise<void>;
  chunkSize?: number;
  chunkPauseMs?: number;
}): Promise<XIngestRunResult> {
  try {
    return await ingestXNotesInner(opts);
  } finally {
    await opts.capture.close?.();
  }
}

async function ingestXNotesInner(opts: {
  profileId?: string;
  note?: string;
  capture: XCaptureAdapter;
  notesRunner?: NotesRunner;
  provider?: OipLocalMemoryProvider;
  now?: Date;
  dryRun?: boolean;
  briefWriter?: NoteBriefWriter;
  onProgress?: (progress: XIngestProgress) => void | Promise<void>;
  chunkSize?: number;
  chunkPauseMs?: number;
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
  const sessionCache: SessionCache = {};
  const chunkSize = ingestChunkSize(opts.chunkSize);
  const chunkPauseMs = ingestChunkPauseMs(opts.chunkPauseMs);

  for (const source of active) {
    const note = await readAppleNote(source.folder, source.note, opts.notesRunner);
    const urls = extractInboxUrls(note.body);
    const ledger = await loadXLedger(profileId);
    const todo = urlsToProcess(urls, ledger);
    const batches = Math.max(1, Math.ceil(todo.length / chunkSize));

    let body = note.body;
    let archiveBody: string | undefined;
    const noteResults: XIngestItemResult[] = [];
    let xStorm = 0;
    let skipRemainingX = false;

    await opts.onProgress?.({
      phase: "start",
      label: todo.length
        ? `Scanning ${todo.length} links from ${source.note} in batches of ${chunkSize}`
        : `No new links in ${source.note}`,
      current: 0,
      total: todo.length,
      percent: 0,
      note: source.note,
      batch: todo.length ? 1 : 0,
      batches: todo.length ? batches : 0,
    });

    for (let i = 0; i < todo.length; i++) {
      const item = todo[i]!;
      const batch = Math.floor(i / chunkSize) + 1;
      const isXLink = isXUrl(item.url) && !isYouTubeUrl(item.url);
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
      if (skipRemainingX && isXLink) {
        processed.push({
          url: item.url,
          canonicalUrl: item.canonicalUrl,
          noteName: source.note,
          noteFolder: source.folder,
          status: "skipped",
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
        sessionCache,
        ledger,
      });
      processed.push(result);
      noteResults.push(result);

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
        if (isXLink) xStorm = 0;
      } else if (result.status === "failed") {
        body = annotateFailureInNoteBody(body, item.url, result.error ?? "unknown error");
        if (isXLink && isXBrowserStormFailure(result.error)) xStorm += 1;
        else if (isXLink) xStorm = 0;
      } else if (isXLink) {
        xStorm = 0;
      }

      const current = i + 1;
      await opts.onProgress?.({
        phase: "item",
        label: `${current}/${todo.length} ${result.status}: ${result.headline || result.url}`,
        current,
        total: todo.length,
        percent: Math.round((current / todo.length) * 100),
        note: source.note,
        url: result.url,
        status: result.status,
        headline: result.headline,
        batch,
        batches,
      });
      if (!skipRemainingX && xStorm >= X_BROWSER_STORM_LIMIT) {
        skipRemainingX = true;
        await writeAppleNote(source.folder, source.note, body, opts.notesRunner);
        if (archiveBody != null) {
          await writeAppleNote(source.folder, source.archiveNote, archiveBody, opts.notesRunner);
        }
        await opts.onProgress?.({
          phase: "pause",
          label:
            "Stopped X ingest after repeated browser failures. Leave Check session alone, keep the ingest Chrome logged in, then scan again. YouTube links will still run.",
          current,
          total: todo.length,
          percent: Math.round((current / todo.length) * 100),
          note: source.note,
          batch,
          batches,
        });
      }

      const endOfChunk = current % chunkSize === 0 || current === todo.length;
      if (endOfChunk) {
        await writeAppleNote(source.folder, source.note, body, opts.notesRunner);
        if (archiveBody != null) {
          await writeAppleNote(source.folder, source.archiveNote, archiveBody, opts.notesRunner);
        }
      }
      if (current % chunkSize === 0 && current < todo.length) {
        await opts.capture.close?.();
        await opts.onProgress?.({
          phase: "pause",
          label: `Pausing after batch ${batch}/${batches} so X does not rate-limit…`,
          current,
          total: todo.length,
          percent: Math.round((current / todo.length) * 100),
          note: source.note,
          batch,
          batches,
        });
        await sleep(chunkPauseMs);
      }
    }

    if (!opts.dryRun && todo.length) {
      try {
        await writeNoteInboxBrief({
          provider,
          profileId,
          source,
          remainingBody: body,
          processed: noteResults,
          now,
          writer: opts.briefWriter,
        });
      } catch (err) {
        console.error(
          `[x-ingest] note brief failed for "${source.note}":`,
          err instanceof Error ? err.message : err,
        );
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

  const saved = processed.filter((p) => p.status === "ingested").length;
  const failed = processed.filter((p) => p.status === "failed").length;
  await opts.onProgress?.({
    phase: "done",
    label: `Done. Saved ${saved}, failed ${failed}.`,
    current: processed.length,
    total: processed.length,
    percent: 100,
  });

  return { processed, sources: active };
}

async function ingestOneUrl(opts: {
  url: string;
  profileId: string;
  capture: XCaptureAdapter;
  provider: OipLocalMemoryProvider;
  sources: XSource[];
  now: Date;
  includeTranscript?: boolean;
  sessionCache?: SessionCache;
  ledger?: Map<string, XLedgerEntry>;
}): Promise<XIngestItemResult> {
  const canonicalUrl = canonicalizeInboxUrl(opts.url);
  const noteName = opts.sources[0]?.note;
  const noteFolder = opts.sources[0]?.folder;
  const ledger = opts.ledger ?? (await loadXLedger(opts.profileId));
  try {
    if (isXUrl(opts.url) && !isYouTubeUrl(opts.url)) {
      const session = await xSessionForRun(opts.capture, opts.sessionCache ?? {});
      if (session && !session.loggedIn) {
        const error = sanitizeXIngestError(session.hint);
        upsertLedgerEntry(ledger, {
          url: opts.url,
          canonicalUrl,
          status: "failed",
          noteNames: noteName ? [noteName] : [],
          noteFolders: noteFolder ? [noteFolder] : [],
          error,
        });
        await saveXLedger(opts.profileId, ledger);
        return {
          url: opts.url,
          canonicalUrl,
          noteName,
          noteFolder,
          status: "failed",
          error,
        };
      }
    }
    const capture = await opts.capture.capture(opts.url);
    if (capture.failure) {
      const error = sanitizeXIngestError(capture.failure.reason);
      upsertLedgerEntry(ledger, {
        url: opts.url,
        canonicalUrl,
        status: "failed",
        noteNames: noteName ? [noteName] : [],
        noteFolders: noteFolder ? [noteFolder] : [],
        error,
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
        error,
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
      transcript: opts.includeTranscript ? capture.text : undefined,
    };
  } catch (err) {
    const message = sanitizeXIngestError(err instanceof Error ? err.message : String(err));
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
