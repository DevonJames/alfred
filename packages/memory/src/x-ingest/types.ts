export type XCaptureKind = "post" | "thread" | "article" | "quote" | "linked_page" | "video";

export type XIngestStatus = "ingested" | "failed" | "in_progress";

export interface XSource {
  id: string;
  folder: string;
  note: string;
  archiveNote: string;
  /** DigitalDocument DID for the note's rolling synthesis brief. */
  briefDid?: string;
}

export interface XSourcesFile {
  sources: XSource[];
}

export interface XLedgerEntry {
  url: string;
  canonicalUrl: string;
  status: XIngestStatus;
  kind?: XCaptureKind;
  headline?: string;
  author?: string;
  authorHandle?: string;
  noteNames: string[];
  noteFolders: string[];
  contentHash?: string;
  lastIngestedAt?: string;
  memoryDid?: string;
  error?: string;
  errorHeadline?: string;
}

export interface XCapturedPost {
  text: string;
  author: string;
  authorHandle?: string;
  publishedAt?: string;
  url?: string;
  images?: string[];
  isReply?: boolean;
}

export interface XCapture {
  url: string;
  canonicalUrl: string;
  kind: XCaptureKind;
  author: string;
  authorHandle?: string;
  publishedAt?: string;
  headline: string;
  text: string;
  posts: XCapturedPost[];
  quoted?: XCapturedPost;
  outboundUrls: string[];
  linkedPage?: { url: string; title: string; text: string };
  screenshots: Array<{ name: string; mimeType: string; bytes: Buffer }>;
  images: Array<{ name: string; mimeType: string; bytes: Buffer }>;
  description?: string;
  durationSeconds?: number;
  videoId?: string;
  failure?: { reason: string; headline?: string };
}

export interface XBrowserSession {
  loggedIn: boolean;
  handle?: string;
  loginOpen?: boolean;
  blocked?: boolean;
  profileDir?: string;
  channel?: "chrome" | "brave" | "chromium";
  browser?: string;
  hint: string;
  error?: string;
}

export interface XCaptureAdapter {
  capture(url: string): Promise<XCapture>;
  probeSession?(): Promise<XBrowserSession>;
  close?(): Promise<void>;
}

export interface XIngestDigestItem {
  url: string;
  canonicalUrl: string;
  noteName?: string;
  headline: string;
  author?: string;
  kind?: XCaptureKind;
  status: "ingested" | "failed";
  error?: string;
  summary?: string;
}

export interface XIngestDigest {
  dayKey: string;
  items: XIngestDigestItem[];
  updatedAt: string;
}

export interface XIngestItemResult {
  url: string;
  canonicalUrl: string;
  noteName?: string;
  noteFolder?: string;
  status: "ingested" | "failed" | "skipped";
  kind?: XCaptureKind;
  headline?: string;
  author?: string;
  error?: string;
  memoryDid?: string;
  summary?: string;
  /** Full caption text. Set only for a single-video ingest, not batch note scans. */
  transcript?: string;
}

export interface XIngestRunResult {
  processed: XIngestItemResult[];
  sources: XSource[];
}

export interface XIngestProgress {
  phase: "start" | "item" | "pause" | "done";
  label: string;
  current: number;
  total: number;
  percent: number;
  note?: string;
  url?: string;
  status?: XIngestItemResult["status"];
  headline?: string;
  batch?: number;
  batches?: number;
}

export type XIngestIntent =
  | { kind: "url"; url: string }
  | { kind: "notes"; note?: string };
