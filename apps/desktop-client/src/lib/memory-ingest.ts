import {
  defaultOipMemoryRoot,
  ingestDocument,
  ingestKnowledgeDocument,
  ingestPhotos,
  mergeAlfredMemoryBundle,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  photoMimeFromFilename,
  type AlfredMemoryMergeReport,
  type KnowledgeIngestResult,
} from "@alfred/memory";
import { extractPdfText, extractPlainText, kindFromFilename } from "./text-extract.js";

export type IngestUploadMode = "knowledge" | "document" | "node-bundle" | "photo";

export type IngestFileResult =
  | (KnowledgeIngestResult & {
      kind: string;
      byteSize: number;
      textChars: number;
      merge?: undefined;
    })
  | {
      mode: "node-bundle";
      providerId: string;
      filename: string;
      kind: string;
      byteSize: number;
      textChars: number;
      userMdUpdated: false;
      userSections: string[];
      created: {
        entities: number;
        episodes: number;
        assertions: number;
        observations: number;
        notes: number;
      };
      skippedSections: string[];
      root: string;
      errors: string[];
      merge: AlfredMemoryMergeReport;
    };

export async function ingestUploadedFile(opts: {
  filename: string;
  bytes: Buffer;
  mode?: IngestUploadMode;
  profileId?: string;
  providerId?: string;
  label?: string;
}): Promise<IngestFileResult> {
  const mode = opts.mode ?? "knowledge";
  if (mode === "document") {
    return ingestDocumentFile(opts);
  }
  if (mode === "photo") {
    return ingestPhotoFile(opts);
  }
  if (mode === "node-bundle") {
    return ingestNodeBundleFile(opts);
  }
  return ingestTextFile(opts);
}

export async function ingestTextFile(opts: {
  filename: string;
  bytes: Buffer;
  profileId?: string;
  providerId?: string;
}): Promise<IngestFileResult> {
  const kind = kindFromFilename(opts.filename);
  if (kind === "pdf") {
    throw new Error(`PDF files require Document ingest mode: ${opts.filename}`);
  }
  if (kind === "image") {
    throw new Error(`Photos require Photo ingest mode: ${opts.filename}`);
  }
  if (kind === "unknown") {
    throw new Error(`Unsupported file type (use .txt, .md, .rtf, or .json): ${opts.filename}`);
  }

  let text: string;
  if (kind === "json") {
    text = opts.bytes.toString("utf8").replace(/^\uFEFF/, "");
  } else {
    text = extractPlainText(opts.bytes, opts.filename).text;
  }
  if (!text.trim()) {
    throw new Error("File contained no extractable text");
  }

  const result = await ingestKnowledgeDocument({
    filename: opts.filename,
    text,
    bytes: opts.bytes,
    profileId: opts.profileId,
    providerId:
      opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID,
  });

  return {
    ...result,
    kind,
    byteSize: opts.bytes.byteLength,
    textChars: text.length,
  };
}

export async function ingestDocumentFile(opts: {
  filename: string;
  bytes: Buffer;
  profileId?: string;
  providerId?: string;
}): Promise<IngestFileResult> {
  const kind = kindFromFilename(opts.filename);
  if (kind !== "pdf") {
    throw new Error(`Document mode accepts PDF files (.pdf): ${opts.filename}`);
  }

  const extracted = await extractPdfText(opts.bytes);
  const result = await ingestDocument({
    filename: opts.filename,
    bytes: opts.bytes,
    pages: extracted.pages,
    text: extracted.text,
    profileId: opts.profileId,
    providerId:
      opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID,
  });

  return {
    ...result,
    kind,
    byteSize: opts.bytes.byteLength,
    textChars: extracted.text.length,
  };
}

export async function ingestPhotoFile(opts: {
  filename: string;
  bytes: Buffer;
  profileId?: string;
  providerId?: string;
  label?: string;
}): Promise<IngestFileResult> {
  return ingestPhotoFiles({
    files: [{ filename: opts.filename, bytes: opts.bytes }],
    profileId: opts.profileId,
    providerId: opts.providerId,
    label: opts.label,
  });
}

export async function ingestPhotoFiles(opts: {
  files: Array<{ filename: string; bytes: Buffer }>;
  profileId?: string;
  providerId?: string;
  label?: string;
}): Promise<IngestFileResult> {
  if (!opts.files.length) {
    throw new Error("Photo mode requires at least one image");
  }
  for (const file of opts.files) {
    if (kindFromFilename(file.filename) !== "image") {
      throw new Error(
        `Photo mode accepts image files (.jpg, .png, .webp, .gif, .heic): ${file.filename}`,
      );
    }
  }

  const providerId =
    opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID;
  const result = await ingestPhotos({
    files: opts.files.map((file) => ({
      filename: file.filename,
      bytes: file.bytes,
      mimeType: photoMimeFromFilename(file.filename),
    })),
    label: opts.label,
    profileId: opts.profileId,
    providerId,
  });

  return {
    ...result,
    kind: "image",
    byteSize: opts.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    textChars: result.textChars,
  };
}

export async function ingestNodeBundleFile(opts: {
  filename: string;
  bytes: Buffer;
  profileId?: string;
}): Promise<IngestFileResult> {
  const lower = opts.filename.toLowerCase();
  if (!lower.endsWith(".zip") && !lower.endsWith(".alfred-memory.zip")) {
    throw new Error(
      `Node bundle mode accepts an Alfred Memory File (.alfred-memory.zip): ${opts.filename}`,
    );
  }
  if (opts.bytes.byteLength < 4 || opts.bytes[0] !== 0x50 || opts.bytes[1] !== 0x4b) {
    throw new Error("File does not look like a zip archive (expected Alfred Memory File)");
  }

  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const localRoot = defaultOipMemoryRoot(profileId);
  const merge = await mergeAlfredMemoryBundle({
    localRoot,
    zipBytes: opts.bytes,
    rebuildIndexes: true,
  });

  return {
    mode: "node-bundle",
    providerId: OIP_LOCAL_MEMORY_PROVIDER_ID,
    filename: opts.filename,
    kind: "zip",
    byteSize: opts.bytes.byteLength,
    textChars: 0,
    userMdUpdated: false,
    userSections: [],
    created: {
      entities: 0,
      episodes: 0,
      assertions: 0,
      observations: 0,
      notes: merge.packagesAdded + merge.revisionsAdded,
    },
    skippedSections: [],
    root: merge.root,
    errors: merge.errors,
    merge,
  };
}
