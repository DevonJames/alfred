import {
  ingestKnowledgeDocument,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  type KnowledgeIngestResult,
} from "@alfred/memory";
import { extractPlainText, kindFromFilename } from "./text-extract.js";

export type IngestFileResult = KnowledgeIngestResult & {
  kind: string;
  byteSize: number;
  textChars: number;
};

export async function ingestTextFile(opts: {
  filename: string;
  bytes: Buffer;
  profileId?: string;
  providerId?: string;
}): Promise<IngestFileResult> {
  const kind = kindFromFilename(opts.filename);
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
