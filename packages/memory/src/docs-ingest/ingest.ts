import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "../oip-local/hashing.js";
import { defaultOipMemoryRoot } from "../oip-local/paths.js";
import { OipLocalMemoryProvider } from "../oip-local/provider.js";
import { chunkMarkdown } from "./chunk.js";
import { defaultDocsExtractor, type DocsExtractor } from "./extract.js";
import { loadDocsLedger, saveDocsLedger, upsertDocsLedgerEntry } from "./ledger.js";
import { upsertFolderEntity, writeDocsFileToOip } from "./oip-write.js";
import { findDocsSource, loadDocsSources } from "./sources.js";
import type { DocsIngestItemResult, DocsIngestRunResult, DocsSource } from "./types.js";
import { isDirectory, walkMarkdownFiles } from "./walk.js";

export async function ingestDocsFolders(opts: {
  profileId?: string;
  path?: string;
  source?: string;
  dryRun?: boolean;
  extractor?: DocsExtractor;
  provider?: OipLocalMemoryProvider;
  now?: Date;
}): Promise<DocsIngestRunResult> {
  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const provider = opts.provider ?? new OipLocalMemoryProvider(defaultOipMemoryRoot(profileId));
  const extractor = opts.extractor ?? defaultDocsExtractor;
  const now = opts.now ?? new Date();
  const learnedAt = now.toISOString();

  let sources = await loadDocsSources(profileId);
  if (opts.path || opts.source) {
    const q = opts.path ?? opts.source ?? "";
    const found = findDocsSource(sources, q);
    sources = found ? [found] : [];
    if (!found && opts.path && (await isDirectory(path.resolve(opts.path)))) {
      sources = [
        {
          id: "adhoc",
          path: path.resolve(opts.path),
          label: path.basename(path.resolve(opts.path)),
        },
      ];
    }
  }

  const ledger = await loadDocsLedger(profileId);
  const processed: DocsIngestItemResult[] = [];
  const folderDids = new Map<string, string>();

  for (const source of sources) {
    if (!(await isDirectory(source.path))) {
      processed.push({
        path: source.path,
        relPath: "",
        folderLabel: source.label,
        status: "failed",
        error: `not a directory: ${source.path}`,
      });
      continue;
    }

    let folderDid = folderDids.get(source.path);
    if (!folderDid && !opts.dryRun) {
      const existingFile = [...ledger.values()].find((e) => e.path.startsWith(`${source.path}/`));
      const folder = await upsertFolderEntity(provider, source, learnedAt, existingFile?.folderDid);
      folderDid = folder.id;
      folderDids.set(source.path, folderDid);
    } else if (!folderDid) {
      folderDid = [...ledger.values()].find((e) => e.path.startsWith(`${source.path}/`))?.folderDid;
    }

    const files = await walkMarkdownFiles(source.path);
    for (const file of files) {
      const bytes = await readFile(file.absPath);
      const contentHash = hashBytes(bytes);
      const prev = ledger.get(file.absPath);
      if (prev?.contentHash === contentHash && prev.fileDid) {
        processed.push({
          path: file.absPath,
          relPath: file.relPath,
          folderLabel: source.label,
          status: "skipped",
          contentHash,
          fileDid: prev.fileDid,
          sections: Object.keys(prev.sectionKeys).length,
        });
        continue;
      }

      const text = bytes.toString("utf8");
      const chunks = chunkMarkdown(text, file.relPath);
      if (opts.dryRun) {
        processed.push({
          path: file.absPath,
          relPath: file.relPath,
          folderLabel: source.label,
          status: "ingested",
          contentHash,
          sections: chunks.length,
        });
        continue;
      }

      try {
        const extracted = [];
        for (const chunk of chunks) {
          const result = await extractor({
            fileRelPath: file.relPath,
            folderLabel: source.label,
            sectionTitle: chunk.title,
            sectionText: chunk.text,
          });
          extracted.push({ chunk, result });
        }
        const written = await writeDocsFileToOip({
          provider,
          source,
          absPath: file.absPath,
          relPath: file.relPath,
          bytes,
          text,
          chunks,
          extracted,
          learnedAt,
          previous: prev,
          folderDid: folderDid!,
        });
        upsertDocsLedgerEntry(ledger, {
          path: file.absPath,
          relPath: file.relPath,
          contentHash,
          folderDid: written.folderDid,
          fileDid: written.fileDid,
          artifactDid: written.artifactDid,
          sectionKeys: written.sectionKeys,
          extractDids: written.extractDids,
          lastIngestedAt: learnedAt,
        });
        processed.push({
          path: file.absPath,
          relPath: file.relPath,
          folderLabel: source.label,
          status: "ingested",
          contentHash,
          fileDid: written.fileDid,
          sections: written.sections,
          extracted: written.extracted,
        });
      } catch (err) {
        processed.push({
          path: file.absPath,
          relPath: file.relPath,
          folderLabel: source.label,
          status: "failed",
          contentHash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!opts.dryRun) {
    await saveDocsLedger(profileId, ledger);
    await provider.rebuildIndexes();
  }

  return { processed, sources };
}

export function speechFromDocsRun(run: DocsIngestRunResult): string {
  const ok = run.processed.filter((p) => p.status === "ingested");
  const skipped = run.processed.filter((p) => p.status === "skipped");
  const failed = run.processed.filter((p) => p.status === "failed");
  if (!run.sources.length) {
    return "There are no documentation folders registered. Add one with ingest-docs-source add --path.";
  }
  if (!run.processed.length) {
    return `No markdown files found in ${run.sources.map((s) => s.label).join(", ")}.`;
  }
  const parts: string[] = [];
  if (ok.length === 1) {
    parts.push(`Ingested ${ok[0]!.relPath} from ${ok[0]!.folderLabel}.`);
  } else if (ok.length > 1) {
    parts.push(`Ingested ${ok.length} documentation files.`);
  }
  if (skipped.length) parts.push(`Skipped ${skipped.length} unchanged files.`);
  for (const f of failed) {
    parts.push(`${f.relPath || f.path} could not be ingested because of ${f.error ?? "an error"}.`);
  }
  return parts.join(" ") || "Docs ingest finished.";
}
