export interface DocsSource {
  id: string;
  path: string;
  label: string;
}

export interface DocsSourcesFile {
  sources: DocsSource[];
}

export interface DocsLedgerEntry {
  path: string;
  relPath: string;
  contentHash: string;
  folderDid: string;
  fileDid: string;
  artifactDid?: string;
  sectionKeys: Record<string, string>;
  extractDids: string[];
  lastIngestedAt?: string;
}

export type DocsIngestStatus = "ingested" | "skipped" | "failed";

export interface DocsIngestItemResult {
  path: string;
  relPath: string;
  folderLabel: string;
  status: DocsIngestStatus;
  contentHash?: string;
  fileDid?: string;
  sections?: number;
  extracted?: number;
  error?: string;
}

export interface DocsIngestRunResult {
  processed: DocsIngestItemResult[];
  sources: DocsSource[];
}

export type DocsIngestIntent =
  | { kind: "run"; source?: string }
  | { kind: "add"; path: string; label?: string }
  | { kind: "list" };

export interface DocsExtractInput {
  fileRelPath: string;
  folderLabel: string;
  sectionTitle: string;
  sectionText: string;
}
