import path from "node:path";
import { defaultXIngestDir } from "../x-ingest/paths.js";

export function defaultDocsSourcesPath(profileId: string): string {
  return path.join(defaultXIngestDir(profileId), "docs-sources.json");
}

export function defaultDocsLedgerPath(profileId: string): string {
  return path.join(defaultXIngestDir(profileId), "docs-ledger.jsonl");
}
