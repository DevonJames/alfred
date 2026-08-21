import { parseMemoryRef } from "../oip-local/ids.js";
import type { MemoryExtractionResult } from "../oip-local/extraction-contract.js";
import { hashBytes } from "../oip-local/hashing.js";
import type { OipLocalMemoryProvider } from "../oip-local/provider.js";
import { SCHEMA_ORG } from "../oip-local/schema-org.js";
import type { MemoryRevision } from "../oip-local/schemas.js";
import type { DocsChunk } from "./chunk.js";
import { asString } from "./extract.js";
import type { DocsLedgerEntry, DocsSource } from "./types.js";

export interface DocsWriteResult {
  folderDid: string;
  fileDid: string;
  artifactDid: string;
  sectionKeys: Record<string, string>;
  extractDids: string[];
  sections: number;
  extracted: number;
}

function docsProvenance(opts: {
  sourcePath: string;
  relPath?: string;
  folderLabel: string;
  contentHash?: string;
  learnedAt: string;
  extractionMethod: string;
}): Record<string, unknown> {
  return {
    sourceType: "docs_folder",
    extractionMethod: opts.extractionMethod,
    sourcePath: opts.sourcePath,
    relPath: opts.relPath,
    folderLabel: opts.folderLabel,
    contentHash: opts.contentHash,
    learnedAt: opts.learnedAt,
  };
}

export async function upsertFolderEntity(
  provider: OipLocalMemoryProvider,
  source: DocsSource,
  learnedAt: string,
  existingDid?: string,
): Promise<MemoryRevision> {
  const body = {
    name: source.label,
    text: `Documentation folder at ${source.path}`,
    schemaType: SCHEMA_ORG.Collection,
    schema: {
      "@type": "Collection",
      name: source.label,
      url: `file://${source.path}`,
    },
    alfred: { entityClass: "docs_folder", visibility: "private" as const, confidence: 1 },
    learnedAt,
    provenance: docsProvenance({
      sourcePath: source.path,
      folderLabel: source.label,
      learnedAt,
      extractionMethod: "docs_folder_ingest",
    }),
  };
  if (existingDid) {
    return provider.updateRecord(existingDid, body, { reindex: false });
  }
  const named = provider.sqlite.findByName(source.label, "Entity");
  const hit = named.find((r) => /docs_folder|collection/i.test(`${r.schema_type ?? ""} ${r.search_text ?? ""}`));
  if (hit) {
    return provider.updateRecord(hit.id, body, { reindex: false });
  }
  return provider.createRecord("Entity", body, undefined, { reindex: false });
}

export async function writeDocsFileToOip(opts: {
  provider: OipLocalMemoryProvider;
  source: DocsSource;
  absPath: string;
  relPath: string;
  bytes: Buffer;
  text: string;
  chunks: DocsChunk[];
  extracted: Array<{ chunk: DocsChunk; result: MemoryExtractionResult }>;
  learnedAt: string;
  previous?: DocsLedgerEntry;
  folderDid: string;
}): Promise<DocsWriteResult> {
  const { provider, source, relPath, bytes, chunks, extracted, learnedAt, previous, folderDid } =
    opts;
  const contentHash = hashBytes(bytes);
  const artifact = await provider.putArtifactBytes(bytes, {
    mimeType: "text/markdown",
    originalFilename: relPath.split("/").pop(),
    name: relPath,
    reindex: false,
  });

  const fileBody = {
    name: relPath,
    text: `${relPath} in ${source.label}`,
    schemaType: SCHEMA_ORG.DigitalDocument,
    schema: {
      "@type": "DigitalDocument",
      name: relPath,
      encodingFormat: "text/markdown",
    },
    alfred: { entityClass: "docs_file", visibility: "private" as const, confidence: 1 },
    learnedAt,
    contentHash,
    originalFilename: relPath,
    provenance: docsProvenance({
      sourcePath: opts.absPath,
      relPath,
      folderLabel: source.label,
      contentHash,
      learnedAt,
      extractionMethod: "docs_folder_ingest",
    }),
    drefs: {
      isPartOf: folderDid,
      sourceArtifact: artifact.id,
    },
  };

  const file = previous?.fileDid
    ? await provider.updateRecord(previous.fileDid, fileBody, { reindex: false })
    : await provider.createRecord("Entity", fileBody, undefined, { reindex: false });

  const sectionKeys: Record<string, string> = {};
  const prevSections = previous?.sectionKeys ?? {};

  for (const chunk of chunks) {
    const name = `${relPath}#${chunk.key}`;
    const sectionBody = {
      name,
      text: chunk.text,
      schemaType: SCHEMA_ORG.CreativeWork,
      schema: { "@type": "CreativeWork", name: chunk.title, text: chunk.text },
      alfred: { visibility: "private" as const, confidence: 1, assertionType: "explicit" as const },
      learnedAt,
      provenance: docsProvenance({
        sourcePath: opts.absPath,
        relPath,
        folderLabel: source.label,
        contentHash,
        learnedAt,
        extractionMethod: "docs_heading_chunk",
      }),
      drefs: {
        isPartOf: file.id,
        sourceArtifact: artifact.id,
      },
    };
    const existingDid = prevSections[chunk.key];
    const rec = existingDid
      ? await provider.updateRecord(existingDid, sectionBody, { reindex: false })
      : await provider.createRecord("Observation", sectionBody, undefined, { reindex: false });
    sectionKeys[chunk.key] = rec.id;
  }

  for (const [key, did] of Object.entries(prevSections)) {
    if (sectionKeys[key]) continue;
    await provider.updateRecord(
      did,
      {
        text: "",
        name: `${relPath}#${key}`,
        supersedes: [did],
        alfred: { visibility: "private" as const, confidence: 0 },
        provenance: docsProvenance({
          sourcePath: opts.absPath,
          relPath,
          folderLabel: source.label,
          contentHash,
          learnedAt,
          extractionMethod: "docs_heading_removed",
        }),
      },
      { reindex: false },
    );
  }

  for (const did of previous?.extractDids ?? []) {
    try {
      const parsed = parseMemoryRef(did.startsWith("did:memory:") ? did : `did:memory:${did}`);
      await provider.packages.deletePackage(parsed.logicalId);
    } catch {
      /* already gone */
    }
  }

  const extractDids: string[] = [];
  const chunkByTitle = new Map(chunks.map((c) => [c.title, c]));
  for (const { chunk, result } of extracted) {
    const sectionDid = sectionKeys[chunk.key] ?? sectionKeys[chunkByTitle.get(chunk.title)?.key ?? ""];
    if (!sectionDid) continue;
    const tempToDid = new Map<string, string>();
    for (const ent of result.entities) {
      const name = asString(ent.name);
      if (!name) continue;
      const entityClass = asString(ent.entityClass) ?? "Thing";
      const quote = asString(ent.quote);
      const summary = asString(ent.summary);
      const rec = await provider.createRecord(
        "Entity",
        {
          name,
          text: [summary, quote ? `Quote: ${quote}` : ""].filter(Boolean).join("\n"),
          schemaType: SCHEMA_ORG.Thing,
          schema: { "@type": entityClass, name, description: summary },
          alfred: {
            entityClass,
            visibility: "private" as const,
            confidence: 0.7,
            assertionType: "inferred" as const,
          },
          learnedAt,
          provenance: docsProvenance({
            sourcePath: opts.absPath,
            relPath,
            folderLabel: source.label,
            contentHash,
            learnedAt,
            extractionMethod: "docs_llm_extract",
          }),
          drefs: {
            isPartOf: file.id,
            derivedFrom: sectionDid,
            sourceArtifact: artifact.id,
          },
        },
        undefined,
        { reindex: false },
      );
      extractDids.push(rec.id);
      const tempId = asString(ent.tempId);
      if (tempId) tempToDid.set(tempId, rec.id);
    }

    for (const assertion of result.assertions) {
      const predicate = asString(assertion.predicate);
      if (!predicate) continue;
      const subjectDid =
        tempToDid.get(asString(assertion.subjectTempId) ?? "") ??
        asString(assertion.subject) ??
        sectionDid;
      const object = asString(assertion.object) ?? asString(assertion.quote) ?? "";
      const rec = await provider.createRecord(
        "Assertion",
        {
          name: predicate,
          text: object,
          predicate,
          subject: subjectDid,
          object,
          schemaType: SCHEMA_ORG.Thing,
          schema: { "@type": "Statement", name: predicate },
          alfred: { visibility: "private" as const, confidence: 0.65, assertionType: "inferred" as const },
          learnedAt,
          provenance: docsProvenance({
            sourcePath: opts.absPath,
            relPath,
            folderLabel: source.label,
            contentHash,
            learnedAt,
            extractionMethod: "docs_llm_extract",
          }),
          drefs: {
            isPartOf: file.id,
            derivedFrom: sectionDid,
            subject: subjectDid,
            sourceArtifact: artifact.id,
          },
        },
        undefined,
        { reindex: false },
      );
      extractDids.push(rec.id);
    }
  }

  return {
    folderDid,
    fileDid: file.id,
    artifactDid: artifact.id,
    sectionKeys,
    extractDids,
    sections: chunks.length,
    extracted: extractDids.length,
  };
}
