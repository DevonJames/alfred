/**
 * Ingest a photo: vision OCR + scene analysis, then the same OIP write path
 * as uploaded documents (artifact + ImageObject + observations + extracted facts).
 */

import {
  defaultOipMemoryRoot,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  OipLocalMemoryProvider,
} from "./oip-local/index.js";
import { hashBytes } from "./oip-local/hashing.js";
import { SCHEMA_ORG } from "./oip-local/schema-org.js";
import { chunkMarkdown, type DocsChunk } from "./docs-ingest/chunk.js";
import {
  asString,
  defaultDocsExtractor,
  emptyExtraction,
  type DocsExtractor,
} from "./docs-ingest/extract.js";
import type { KnowledgeIngestResult } from "./knowledge-ingest.js";
import type { MemoryExtractionResult } from "./oip-local/extraction-contract.js";
import type { MemoryRevision } from "./oip-local/schemas.js";
import {
  analyzePhoto,
  formatPhotoMarkdown,
  photoMimeFromFilename,
  type PhotoAnalysis,
} from "./photo-analyze.js";
import { preparePhotoForVision } from "./photo-heic.js";

export type PhotoIngestResult = KnowledgeIngestResult & {
  mode: "photo";
  pages: number;
  sections: number;
  backend: PhotoAnalysis["backend"];
  model: string;
  textChars: number;
  label?: string;
  albumId?: string;
  photos?: number;
  filenames?: string[];
  fileId?: string;
};

function partOf(fileId: string, albumDid?: string): string | string[] {
  return albumDid ? [fileId, albumDid] : fileId;
}

export async function upsertPhotoAlbumEntity(
  provider: OipLocalMemoryProvider,
  label: string,
  learnedAt: string,
): Promise<MemoryRevision> {
  const name = label.trim();
  const body = {
    name,
    text: name,
    schemaType: SCHEMA_ORG.Collection,
    schema: {
      "@type": "Collection",
      name,
    },
    alfred: { entityClass: "photo_album", visibility: "private" as const, confidence: 1 },
    learnedAt,
    provenance: {
      sourceType: "photo_upload",
      extractionMethod: "photo_album",
      folderLabel: name,
      learnedAt,
    },
  };
  const named = provider.sqlite.findByName(name, "Entity");
  const hit = named.find((r) =>
    /photo_album|docs_folder|collection/i.test(`${r.schema_type ?? ""} ${r.search_text ?? ""}`),
  );
  if (hit) {
    const current = await provider.packages.readCurrent(hit.logical_id);
    if (current) return current;
  }
  return provider.createRecord("Entity", body, undefined, { reindex: false });
}

function photoProvenance(opts: {
  filename: string;
  contentHash: string;
  learnedAt: string;
  extractionMethod: string;
  backend?: string;
  folderLabel?: string;
  originalFormat?: string;
}): Record<string, unknown> {
  return {
    sourceType: "photo_upload",
    extractionMethod: opts.extractionMethod,
    originalFilename: opts.filename,
    relPath: opts.filename,
    contentHash: opts.contentHash,
    learnedAt: opts.learnedAt,
    ...(opts.backend ? { visionBackend: opts.backend } : {}),
    ...(opts.folderLabel ? { folderLabel: opts.folderLabel } : {}),
    ...(opts.originalFormat ? { originalFormat: opts.originalFormat } : {}),
  };
}

export async function ingestPhoto(opts: {
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  analysis?: PhotoAnalysis;
  analyze?: (input: { filename: string; bytes: Buffer; mimeType: string }) => Promise<PhotoAnalysis>;
  profileId?: string;
  providerId?: string;
  extractor?: DocsExtractor;
  label?: string;
  albumDid?: string;
  reindex?: boolean;
}): Promise<PhotoIngestResult> {
  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const providerId =
    opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID;
  if (providerId !== OIP_LOCAL_MEMORY_PROVIDER_ID && providerId !== "memory.oip-local") {
    throw new Error("Photo ingest requires the local OIP memory provider");
  }

  const prepared = await preparePhotoForVision({
    filename: opts.filename,
    bytes: opts.bytes,
    mimeType: opts.mimeType || photoMimeFromFilename(opts.filename),
  });
  const mimeType = prepared.mimeType;
  const bytes = prepared.bytes;
  if (prepared.convertedFrom) {
    console.log(`[photo-ingest] converted ${opts.filename} ${prepared.convertedFrom} → ${mimeType}`);
  }
  if (!opts.analysis) {
    console.log(`[photo-ingest] vision ${opts.filename} (${bytes.byteLength} bytes)`);
  }
  const analysis =
    opts.analysis ??
    (await (opts.analyze ?? analyzePhoto)({
      filename: opts.filename,
      bytes,
      mimeType,
    }));
  const markdown = formatPhotoMarkdown(opts.filename, analysis).replace(/\u0000/g, "").trim();
  if (!markdown) {
    throw new Error("Photo analysis returned no text");
  }

  const chunks = chunkMarkdown(markdown, opts.filename);
  if (!chunks.length) {
    throw new Error("Photo analysis returned no text");
  }

  const root = defaultOipMemoryRoot(profileId);
  const provider = new OipLocalMemoryProvider(root);
  const learnedAt = new Date().toISOString();
  const contentHash = hashBytes(bytes);
  const extractor = opts.extractor ?? defaultDocsExtractor;
  const errors: string[] = [];
  const label = opts.label?.trim() || undefined;
  let albumDid = opts.albumDid;
  if (!albumDid && label) {
    albumDid = (await upsertPhotoAlbumEntity(provider, label, learnedAt)).id;
  }
  const provenanceBase = {
    filename: opts.filename,
    contentHash,
    learnedAt,
    backend: analysis.backend,
    folderLabel: label,
    originalFormat: prepared.convertedFrom,
  };

  const artifact = await provider.putArtifactBytes(bytes, {
    mimeType,
    originalFilename: opts.filename,
    name: opts.filename,
    reindex: false,
  });

  const file = await provider.createRecord(
    "Entity",
    {
      name: opts.filename,
      text: analysis.summary || opts.filename,
      schemaType: SCHEMA_ORG.ImageObject,
      schema: {
        "@type": "ImageObject",
        name: opts.filename,
        encodingFormat: mimeType,
        description: analysis.summary,
      },
      alfred: { entityClass: "uploaded_photo", visibility: "private" as const, confidence: 1 },
      learnedAt,
      contentHash,
      originalFilename: opts.filename,
      provenance: photoProvenance({
        ...provenanceBase,
        extractionMethod: "photo_vision",
      }),
      drefs: {
        sourceArtifact: artifact.id,
        ...(albumDid ? { isPartOf: albumDid } : {}),
      },
    },
    undefined,
    { reindex: false },
  );

  const sectionKeys: Record<string, string> = {};
  for (const chunk of chunks) {
    const name = `${opts.filename}#${chunk.key}`;
    const rec = await provider.createRecord(
      "Observation",
      {
        name,
        text: chunk.text,
        schemaType: SCHEMA_ORG.CreativeWork,
        schema: { "@type": "CreativeWork", name: chunk.title, text: chunk.text },
        alfred: { visibility: "private" as const, confidence: 1, assertionType: "explicit" as const },
        learnedAt,
        provenance: photoProvenance({
          ...provenanceBase,
          extractionMethod: "photo_ocr_chunk",
        }),
        drefs: {
          isPartOf: partOf(file.id, albumDid),
          sourceArtifact: artifact.id,
        },
      },
      undefined,
      { reindex: false },
    );
    sectionKeys[chunk.key] = rec.id;
  }

  const created = {
    entities: 1,
    episodes: 0,
    assertions: 0,
    observations: chunks.length,
    notes: 0,
  };

  const extracted = await extractChunks({
    chunks,
    filename: opts.filename,
    extractor,
    errors,
    folderLabel: label ?? "Uploaded photo",
  });

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
          provenance: photoProvenance({
            ...provenanceBase,
            extractionMethod: "photo_llm_extract",
          }),
          drefs: {
            isPartOf: partOf(file.id, albumDid),
            derivedFrom: sectionDid,
            sourceArtifact: artifact.id,
          },
        },
        undefined,
        { reindex: false },
      );
      created.entities += 1;
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
      await provider.createRecord(
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
          provenance: photoProvenance({
            ...provenanceBase,
            extractionMethod: "photo_llm_extract",
          }),
          drefs: {
            isPartOf: partOf(file.id, albumDid),
            derivedFrom: sectionDid,
            subject: subjectDid,
            sourceArtifact: artifact.id,
          },
        },
        undefined,
        { reindex: false },
      );
      created.assertions += 1;
    }
  }

  if (opts.reindex !== false) await provider.rebuildIndexes();
  if (albumDid) created.entities += label && !opts.albumDid ? 1 : 0;

  return {
    mode: "photo",
    providerId: OIP_LOCAL_MEMORY_PROVIDER_ID,
    filename: opts.filename,
    userMdUpdated: false,
    userSections: [],
    artifactId: artifact.id,
    created,
    skippedSections: [],
    root,
    errors,
    pages: 1,
    sections: chunks.length,
    backend: analysis.backend,
    model: analysis.model,
    textChars: markdown.length,
    label,
    albumId: albumDid,
    photos: 1,
    filenames: [opts.filename],
    fileId: file.id,
  };
}

export async function ingestPhotos(opts: {
  files: Array<{
    filename: string;
    bytes: Buffer;
    mimeType?: string;
    analysis?: PhotoAnalysis;
  }>;
  label?: string;
  analyze?: (input: { filename: string; bytes: Buffer; mimeType: string }) => Promise<PhotoAnalysis>;
  profileId?: string;
  providerId?: string;
  extractor?: DocsExtractor;
}): Promise<PhotoIngestResult> {
  if (!opts.files.length) throw new Error("Photo ingest requires at least one image");
  if (opts.files.length === 1) {
    return ingestPhoto({ ...opts.files[0]!, ...opts });
  }

  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const providerId =
    opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID;
  if (providerId !== OIP_LOCAL_MEMORY_PROVIDER_ID && providerId !== "memory.oip-local") {
    throw new Error("Photo ingest requires the local OIP memory provider");
  }

  const root = defaultOipMemoryRoot(profileId);
  const provider = new OipLocalMemoryProvider(root);
  const learnedAt = new Date().toISOString();
  const label = opts.label?.trim() || undefined;

  const created = {
    entities: 0,
    episodes: 0,
    assertions: 0,
    observations: 0,
    notes: 0,
  };
  const errors: string[] = [];
  const filenames: string[] = [];
  let textChars = 0;
  let sections = 0;
  let backend: PhotoAnalysis["backend"] = "openai";
  let model = "";
  let artifactId: string | undefined;
  let albumId: string | undefined;
  const fileDids: string[] = [];

  try {
    for (const [index, file] of opts.files.entries()) {
      console.log(
        `[photo-ingest] ${index + 1}/${opts.files.length} ${file.filename} (${file.bytes.byteLength} bytes)`,
      );
      const one = await ingestPhoto({
        ...file,
        analyze: opts.analyze,
        profileId,
        providerId,
        extractor: opts.extractor,
        label,
        albumDid: albumId,
        reindex: false,
      });
      albumId ??= one.albumId;
      created.entities += one.created.entities;
      created.episodes += one.created.episodes;
      created.assertions += one.created.assertions;
      created.observations += one.created.observations;
      created.notes += one.created.notes;
      errors.push(...one.errors);
      filenames.push(file.filename);
      textChars += one.textChars;
      sections += one.sections;
      backend = one.backend;
      model = one.model;
      artifactId ??= one.artifactId;
      if (one.fileId) fileDids.push(one.fileId);
    }

    for (let i = 0; i < fileDids.length - 1; i++) {
      const from = fileDids[i]!;
      const to = fileDids[i + 1]!;
      await provider.createRecord(
        "Assertion",
        {
          name: "relatedTo",
          text: `${filenames[i]} is part of the same photo set as ${filenames[i + 1]}`,
          predicate: "relatedTo",
          subject: from,
          object: to,
          schemaType: SCHEMA_ORG.Thing,
          schema: { "@type": "Statement", name: "relatedTo" },
          alfred: { visibility: "private" as const, confidence: 1, assertionType: "explicit" as const },
          learnedAt,
          provenance: {
            sourceType: "photo_upload",
            extractionMethod: "photo_set",
            learnedAt,
            ...(label ? { folderLabel: label } : {}),
          },
          drefs: {
            ...(albumId ? { isPartOf: albumId } : {}),
            subject: from,
            object: to,
          },
        },
        undefined,
        { reindex: false },
      );
      created.assertions += 1;
    }
  } finally {
    await provider.rebuildIndexes();
  }

  return {
    mode: "photo",
    providerId: OIP_LOCAL_MEMORY_PROVIDER_ID,
    filename: filenames.length === 1 ? filenames[0]! : `${filenames.length} photos`,
    userMdUpdated: false,
    userSections: [],
    artifactId,
    created,
    skippedSections: [],
    root,
    errors,
    pages: filenames.length,
    sections,
    backend,
    model,
    textChars,
    label,
    albumId,
    photos: filenames.length,
    filenames,
  };
}

async function extractChunks(opts: {
  chunks: DocsChunk[];
  filename: string;
  extractor: DocsExtractor;
  errors: string[];
  folderLabel: string;
}): Promise<Array<{ chunk: DocsChunk; result: MemoryExtractionResult }>> {
  const extracted: Array<{ chunk: DocsChunk; result: MemoryExtractionResult }> = [];
  for (const chunk of opts.chunks) {
    try {
      const result = await opts.extractor({
        fileRelPath: opts.filename,
        folderLabel: opts.folderLabel,
        sectionTitle: chunk.title,
        sectionText: chunk.text,
      });
      extracted.push({ chunk, result });
    } catch (err) {
      opts.errors.push(err instanceof Error ? err.message : String(err));
      extracted.push({ chunk, result: emptyExtraction() });
    }
  }
  return extracted;
}
