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

export type DocumentIngestResult = KnowledgeIngestResult & {
  mode: "document";
  pages: number;
  sections: number;
};

/**
 * Turn extracted PDF page texts into heading markdown so the docs chunker
 * can split on `# Page N` (and further on oversized pages).
 */
export function pagesToMarkdown(pages: string[]): string {
  return pages
    .map((page, i) => {
      const body = page.replace(/\u0000/g, "").trim();
      return body ? `# Page ${i + 1}\n\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function documentProvenance(opts: {
  filename: string;
  contentHash: string;
  learnedAt: string;
  extractionMethod: string;
}): Record<string, unknown> {
  return {
    sourceType: "document_upload",
    extractionMethod: opts.extractionMethod,
    originalFilename: opts.filename,
    relPath: opts.filename,
    contentHash: opts.contentHash,
    learnedAt: opts.learnedAt,
  };
}

/**
 * Ingest a one-shot uploaded document (PDF) into OIP.
 * Stores the original bytes as an artifact, a DigitalDocument entity, and
 * verbatim page/section Observations. Does not patch USER.md or watch a folder.
 */
export async function ingestDocument(opts: {
  filename: string;
  bytes: Buffer;
  pages?: string[];
  text?: string;
  profileId?: string;
  providerId?: string;
  extractor?: DocsExtractor;
}): Promise<DocumentIngestResult> {
  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const providerId =
    opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID;
  if (providerId !== OIP_LOCAL_MEMORY_PROVIDER_ID && providerId !== "memory.oip-local") {
    throw new Error("Document ingest requires the local OIP memory provider");
  }

  const markdown = opts.pages?.length
    ? pagesToMarkdown(opts.pages)
    : (opts.text ?? "").replace(/\u0000/g, "").trim();
  if (!markdown) {
    throw new Error("Document contained no extractable text");
  }

  const pageCount = opts.pages?.length
    ? opts.pages.filter((p) => p.replace(/\u0000/g, "").trim()).length
    : (markdown.match(/^# Page \d+/gm) ?? []).length || 1;

  const chunks = chunkMarkdown(markdown, opts.filename);
  if (!chunks.length) {
    throw new Error("Document contained no extractable text");
  }

  const root = defaultOipMemoryRoot(profileId);
  const provider = new OipLocalMemoryProvider(root);
  const learnedAt = new Date().toISOString();
  const contentHash = hashBytes(opts.bytes);
  const extractor = opts.extractor ?? defaultDocsExtractor;
  const errors: string[] = [];

  const artifact = await provider.putArtifactBytes(opts.bytes, {
    mimeType: "application/pdf",
    originalFilename: opts.filename,
    name: opts.filename,
    reindex: false,
  });

  const file = await provider.createRecord(
    "Entity",
    {
      name: opts.filename,
      text: opts.filename,
      schemaType: SCHEMA_ORG.DigitalDocument,
      schema: {
        "@type": "DigitalDocument",
        name: opts.filename,
        encodingFormat: "application/pdf",
      },
      alfred: { entityClass: "uploaded_document", visibility: "private" as const, confidence: 1 },
      learnedAt,
      contentHash,
      originalFilename: opts.filename,
      provenance: documentProvenance({
        filename: opts.filename,
        contentHash,
        learnedAt,
        extractionMethod: "document_upload",
      }),
      drefs: {
        sourceArtifact: artifact.id,
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
        provenance: documentProvenance({
          filename: opts.filename,
          contentHash,
          learnedAt,
          extractionMethod: "document_page_chunk",
        }),
        drefs: {
          isPartOf: file.id,
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
          provenance: documentProvenance({
            filename: opts.filename,
            contentHash,
            learnedAt,
            extractionMethod: "document_llm_extract",
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
          provenance: documentProvenance({
            filename: opts.filename,
            contentHash,
            learnedAt,
            extractionMethod: "document_llm_extract",
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
      created.assertions += 1;
    }
  }

  await provider.rebuildIndexes();

  return {
    mode: "document",
    providerId: OIP_LOCAL_MEMORY_PROVIDER_ID,
    filename: opts.filename,
    userMdUpdated: false,
    userSections: [],
    artifactId: artifact.id,
    created,
    skippedSections: [],
    root,
    errors,
    pages: pageCount,
    sections: chunks.length,
  };
}

async function extractChunks(opts: {
  chunks: DocsChunk[];
  filename: string;
  extractor: DocsExtractor;
  errors: string[];
}): Promise<Array<{ chunk: DocsChunk; result: MemoryExtractionResult }>> {
  const extracted: Array<{ chunk: DocsChunk; result: MemoryExtractionResult }> = [];
  for (const chunk of opts.chunks) {
    try {
      const result = await opts.extractor({
        fileRelPath: opts.filename,
        folderLabel: "Uploaded document",
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
