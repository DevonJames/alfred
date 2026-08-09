import { createId } from "@alfred/contracts";
import {
  defaultMemoryPath,
  defaultOipMemoryRoot,
  LOCAL_MEMORY_PROVIDER_ID,
  LocalFileMemoryProvider,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  OipLocalMemoryProvider,
} from "@alfred/memory";
import { extractPlainText, mimeForKind } from "./text-extract.js";

export interface IngestFileResult {
  providerId: string;
  filename: string;
  kind: string;
  byteSize: number;
  textChars: number;
  observationId?: string;
  artifactId?: string;
  noteId?: string;
  root: string;
}

export async function ingestTextFile(opts: {
  filename: string;
  bytes: Buffer;
  profileId?: string;
  providerId?: string;
}): Promise<IngestFileResult> {
  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const providerId =
    opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID;

  const { text, kind } = extractPlainText(opts.bytes, opts.filename);
  if (!text.trim()) {
    throw new Error("File contained no extractable text");
  }

  const now = new Date().toISOString();

  if (providerId === OIP_LOCAL_MEMORY_PROVIDER_ID || providerId === "memory.oip-local") {
    const root = defaultOipMemoryRoot(profileId);
    const provider = new OipLocalMemoryProvider(root);
    const artifact = await provider.putArtifactBytes(opts.bytes, {
      mimeType: mimeForKind(kind),
      originalFilename: opts.filename,
      name: opts.filename,
    });
    const observation = await provider.createRecord("Observation", {
      text,
      name: opts.filename,
      observedAt: now,
      sourceArtifact: artifact.id,
      schemaType: "https://schema.org/CreativeWork",
      schema: {
        "@type": "CreativeWork",
        name: opts.filename,
        text,
        encodingFormat: mimeForKind(kind),
      },
      alfred: {
        visibility: "private",
        confidence: 1,
        assertionType: "extracted",
      },
      drefs: {
        sourceArtifact: artifact.id,
      },
      provenance: {
        sourceType: "file_ingest",
        learnedAt: now,
        extractionMethod: "desktop_client_upload",
        source: artifact.id,
      },
      learnedAt: now,
    });

    return {
      providerId: OIP_LOCAL_MEMORY_PROVIDER_ID,
      filename: opts.filename,
      kind,
      byteSize: opts.bytes.byteLength,
      textChars: text.length,
      observationId: observation.id,
      artifactId: artifact.id,
      root,
    };
  }

  // Fallback: JSONL local notes
  const filePath = defaultMemoryPath(profileId);
  const local = new LocalFileMemoryProvider(filePath, LOCAL_MEMORY_PROVIDER_ID);
  const noteId = createId("mem");
  await local.importCanonical([
    {
      id: noteId,
      content: text,
      createdAt: now,
      metadata: {
        kind: "note",
        sourceId: `ingest:${opts.filename}`,
        filename: opts.filename,
        ingestKind: kind,
      },
    },
  ]);

  return {
    providerId: LOCAL_MEMORY_PROVIDER_ID,
    filename: opts.filename,
    kind,
    byteSize: opts.bytes.byteLength,
    textChars: text.length,
    noteId,
    root: filePath,
  };
}
