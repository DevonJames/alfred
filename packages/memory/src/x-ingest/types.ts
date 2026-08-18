export type XCaptureKind = "post" | "thread" | "article" | "quote" | "linked_page" | "video";

export type XIngestStatus = "ingested" | "failed" | "in_progress";

export interface XSource {
  id: string;
  folder: string;
  note: string;
  archiveNote: string;
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

export interface XCaptureAdapter {
  capture(url: string): Promise<XCapture>;
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
}

export interface XIngestRunResult {
  processed: XIngestItemResult[];
  sources: XSource[];
}

export type XIngestIntent =
  | { kind: "url"; url: string }
  | { kind: "notes"; note?: string };
