import { parseMarkdownSections } from "../ingest-export.js";

export interface DocsChunk {
  key: string;
  title: string;
  text: string;
}

const MAX_CHARS = 3500;

export function slugHeading(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/**
 * Split markdown into verbatim heading sections. Oversized sections split on
 * blank lines, never inside fenced code.
 */
export function chunkMarkdown(markdown: string, relPath: string): DocsChunk[] {
  const fileStem = relPath.replace(/\.[^.]+$/, "").split("/").pop() || relPath;
  const sections = parseMarkdownSections(markdown);
  const used = new Map<string, number>();
  const chunks: DocsChunk[] = [];

  for (const section of sections) {
    const title = section.level === 0 ? fileStem : section.title;
    const body = section.body.trim();
    if (!body && section.level === 0) continue;
    const text = body ? `# ${title}\n\n${body}` : `# ${title}`;
    for (const piece of splitOversized(text, title)) {
      chunks.push({
        key: uniqueKey(slugHeading(piece.title), used),
        title: piece.title,
        text: piece.text,
      });
    }
  }

  if (!chunks.length && markdown.trim()) {
    chunks.push({
      key: uniqueKey(slugHeading(fileStem), used),
      title: fileStem,
      text: markdown.trim(),
    });
  }
  return chunks;
}

function uniqueKey(base: string, used: Map<string, number>): string {
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

function splitOversized(text: string, title: string): Array<{ title: string; text: string }> {
  if (text.length <= MAX_CHARS) return [{ title, text }];
  const parts: Array<{ title: string; text: string }> = [];
  let buf: string[] = [];
  let bufLen = 0;
  let inFence = false;
  let part = 1;

  const flush = () => {
    const joined = buf.join("\n").trim();
    if (!joined) {
      buf = [];
      bufLen = 0;
      return;
    }
    const partTitle = parts.length ? `${title} (${part})` : title;
    parts.push({ title: partTitle, text: joined });
    part += 1;
    buf = [];
    bufLen = 0;
  };

  for (const line of text.split("\n")) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    const nextLen = bufLen + line.length + 1;
    if (!inFence && bufLen > 0 && nextLen > MAX_CHARS && /^\s*$/.test(line)) {
      flush();
      continue;
    }
    buf.push(line);
    bufLen = nextLen;
  }
  flush();
  return parts.length ? parts : [{ title, text }];
}
