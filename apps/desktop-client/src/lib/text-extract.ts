/**
 * Extract plain text from .txt / .md / .rtf uploads, or PDF page text.
 */

export type IngestTextKind = "txt" | "md" | "rtf" | "json" | "pdf" | "unknown";

export function kindFromFilename(filename: string): IngestTextKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "txt" || ext === "text") return "txt";
  if (ext === "md" || ext === "markdown" || ext === "mdown") return "md";
  if (ext === "rtf") return "rtf";
  if (ext === "json") return "json";
  if (ext === "pdf") return "pdf";
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
    default:
      return "application/octet-stream";
  }
}

export function extractPlainText(bytes: Buffer, filename: string): { text: string; kind: IngestTextKind } {
  const kind = kindFromFilename(filename);
  if (kind === "pdf") {
    throw new Error(`PDF files require Document ingest mode: ${filename}`);
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

/**
 * Lightweight RTF → plain text. Good enough for notes; not a full RTF engine.
 */
export function rtfToPlainText(rtf: string): string {
  let s = rtf.replace(/\r\n?/g, "\n");

  // Drop font/color tables and similar destination groups.
  s = s.replace(/\{\\fonttbl[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\colortbl[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\stylesheet[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\\*\\[^}]+\}/g, "");

  // Unicode chars: \'hh and \uN?
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  s = s.replace(/\\u(-?\d+)\??/g, (_, n: string) => {
    const code = Number(n);
    return code < 0 ? "" : String.fromCharCode(code);
  });

  // Paragraph / line breaks
  s = s.replace(/\\par[d]?/gi, "\n");
  s = s.replace(/\\line\b/gi, "\n");
  s = s.replace(/\\tab\b/gi, "\t");

  // Strip remaining control words and groups
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, "");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\\\\/g, "\\");

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdfText(bytes: Buffer): Promise<{
  text: string;
  pages: string[];
  pageCount: number;
  kind: "pdf";
}> {
  let extractText: typeof import("unpdf").extractText;
  let getDocumentProxy: typeof import("unpdf").getDocumentProxy;
  try {
    ({ extractText, getDocumentProxy } = await import("unpdf"));
  } catch {
    throw new Error("PDF extraction is unavailable (unpdf failed to load)");
  }

  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw new Error("Could not read this PDF. The file may be damaged or password-protected.");
  }

  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((page) =>
    page.replace(/\u0000/g, "").trim(),
  );
  if (!pages.some(Boolean)) {
    throw new Error("PDF contained no extractable text (it may be scanned images only)");
  }

  const combined = pages
    .map((page, i) => (page ? `# Page ${i + 1}\n\n${page}` : ""))
    .filter(Boolean)
    .join("\n\n");

  return { text: combined, pages, pageCount: totalPages, kind: "pdf" };
}
