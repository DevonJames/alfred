/**
 * Extract plain text from .txt / .md / .rtf uploads, or PDF page text.
 */

import { extractPdfPages, isPhotoFilename, rtfToPlainText } from "@alfred/memory";

export { rtfToPlainText };

export type IngestTextKind = "txt" | "md" | "rtf" | "json" | "pdf" | "image" | "unknown";

export function kindFromFilename(filename: string): IngestTextKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "txt" || ext === "text") return "txt";
  if (ext === "md" || ext === "markdown" || ext === "mdown") return "md";
  if (ext === "rtf") return "rtf";
  if (ext === "json") return "json";
  if (ext === "pdf") return "pdf";
  if (isPhotoFilename(filename)) return "image";
  return "unknown";
}

export function mimeForKind(kind: IngestTextKind): string {
  switch (kind) {
    case "md":
      return "text/markdown";
    case "rtf":
      return "application/rtf";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "image":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}

export function extractPlainText(bytes: Buffer, filename: string): { text: string; kind: IngestTextKind } {
  const kind = kindFromFilename(filename);
  if (kind === "pdf") {
    throw new Error(`PDF files require Document ingest mode: ${filename}`);
  }
  if (kind === "image") {
    throw new Error(`Photos require Photo ingest mode: ${filename}`);
  }
  if (kind === "unknown") {
    throw new Error(`Unsupported file type (use .txt, .md, .rtf, or .json): ${filename}`);
  }
  const raw = bytes.toString("utf8");
  if (kind === "rtf") {
    return { text: rtfToPlainText(raw), kind };
  }
  // txt / md / json — keep as-is
  return { text: raw.replace(/^\uFEFF/, ""), kind };
}

export async function extractPdfText(bytes: Buffer): Promise<{
  text: string;
  pages: string[];
  pageCount: number;
  kind: "pdf";
}> {
  const extracted = await extractPdfPages(bytes);
  return { ...extracted, kind: "pdf" };
}
