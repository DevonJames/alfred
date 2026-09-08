import path from "node:path";

export type DocsFileKind = "md" | "txt" | "rtf" | "pdf";

const KIND_BY_EXT: Record<string, DocsFileKind> = {
  ".md": "md",
  ".mdx": "md",
  ".markdown": "md",
  ".mdown": "md",
  ".txt": "txt",
  ".text": "txt",
  ".rtf": "rtf",
  ".pdf": "pdf",
};

export function docsFileKindFromPath(filePath: string): DocsFileKind | undefined {
  return KIND_BY_EXT[path.extname(filePath).toLowerCase()];
}

export function ingestMimeFromFilename(filename: string): string {
  const kind = docsFileKindFromPath(filename);
  if (kind) return mimeForDocsFileKind(kind);
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

export function mimeForDocsFileKind(kind: DocsFileKind): string {
  switch (kind) {
    case "md":
      return "text/markdown";
    case "rtf":
      return "application/rtf";
    case "txt":
      return "text/plain";
    case "pdf":
      return "application/pdf";
  }
}

/**
 * Lightweight RTF → plain text. Good enough for notes; not a full RTF engine.
 */
export function rtfToPlainText(rtf: string): string {
  let s = rtf.replace(/\r\n?/g, "\n");

  s = s.replace(/\{\\fonttbl[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\colortbl[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\stylesheet[\s\S]*?\}/gi, "");
  s = s.replace(/\{\\\*\\[^}]+\}/g, "");

  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  s = s.replace(/\\u(-?\d+)\??/g, (_, n: string) => {
    const code = Number(n);
    return code < 0 ? "" : String.fromCharCode(code);
  });

  s = s.replace(/\\par[d]?/gi, "\n");
  s = s.replace(/\\line\b/gi, "\n");
  s = s.replace(/\\tab\b/gi, "\t");

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

export function pagesToMarkdown(pages: string[]): string {
  return pages
    .map((page, i) => {
      const body = page.replace(/\u0000/g, "").trim();
      return body ? `# Page ${i + 1}\n\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function extractPdfPages(bytes: Buffer): Promise<{
  text: string;
  pages: string[];
  pageCount: number;
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
  return { text: pagesToMarkdown(pages), pages, pageCount: totalPages };
}

export async function extractDocsFileText(
  bytes: Buffer,
  filePath: string,
): Promise<{ text: string; kind: DocsFileKind }> {
  const kind = docsFileKindFromPath(filePath);
  if (!kind) {
    throw new Error(`Unsupported docs-folder file type: ${filePath}`);
  }
  if (kind === "pdf") {
    const extracted = await extractPdfPages(bytes);
    return { text: extracted.text, kind };
  }
  const raw = bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (kind === "rtf") {
    return { text: rtfToPlainText(raw), kind };
  }
  return { text: raw, kind };
}
