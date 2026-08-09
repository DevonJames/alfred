/**
 * Extract plain text from .txt / .md / .rtf uploads.
 */

export type IngestTextKind = "txt" | "md" | "rtf" | "json" | "unknown";

export function kindFromFilename(filename: string): IngestTextKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "txt" || ext === "text") return "txt";
  if (ext === "md" || ext === "markdown" || ext === "mdown") return "md";
  if (ext === "rtf") return "rtf";
  if (ext === "json") return "json";
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
    default:
      return "application/octet-stream";
  }
}

export function extractPlainText(bytes: Buffer, filename: string): { text: string; kind: IngestTextKind } {
  const kind = kindFromFilename(filename);
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
