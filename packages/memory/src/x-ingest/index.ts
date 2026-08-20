export { archiveNoteName, addXSource, findXSource, loadXSources, removeXSource, saveXSources } from "./sources.js";
export {
  archiveDisplayUrl,
  canonicalizeInboxUrl,
  canonicalizeXUrl,
  canonicalizeYouTubeUrl,
  extractInboxLinkUrls,
  extractXUrls,
  extractYouTubeUrls,
  isXUrl,
  isYouTubePlaylistOrChannelUrl,
  isYouTubeUrl,
  slugFromTitle,
  statusIdFromUrl,
  handleFromXStatusUrl,
  youtubeVideoIdFromUrl,
} from "./urls.js";
export { composeNotesCaptureAdapter } from "./capture.js";
export { captureYouTubeVideo, vttToPlainText, type YtDlpRunner } from "./youtube-capture.js";
export { loadXLedger, saveXLedger, upsertLedgerEntry, urlsToProcess } from "./ledger.js";
export {
  annotateFailureInNoteBody,
  appendArchiveLine,
  defaultNotesRunner,
  extractInboxUrls,
  readAppleNote,
  removeUrlFromNoteBody,
  writeAppleNote,
  type NotesNote,
  type NotesRunner,
} from "./notes.js";
export { appendXIngestDigest, invalidateBriefingCacheFile, loadXIngestDigest } from "./digest.js";
export { ingestXNotes, ingestXUrl } from "./ingest.js";
export { looksLikeXIngest, parseLearnedAtWindow, parseXIngestIntent } from "./intent.js";
export { captureContentHash, writeXCaptureToOip } from "./oip-write.js";
export {
  defaultBriefingCacheFile,
  defaultBriefingDataDir,
  defaultXIngestDigestPath,
  defaultXIngestDir,
  defaultXLedgerPath,
  defaultXSourcesPath,
  ingestDayKey,
} from "./paths.js";
export type {
  XCapture,
  XCaptureAdapter,
  XCaptureKind,
  XCapturedPost,
  XIngestDigest,
  XIngestDigestItem,
  XIngestIntent,
  XIngestItemResult,
  XIngestRunResult,
  XIngestStatus,
  XLedgerEntry,
  XSource,
  XSourcesFile,
} from "./types.js";
