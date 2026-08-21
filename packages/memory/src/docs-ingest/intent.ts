import type { DocsIngestIntent } from "./types.js";

const DOCS_INGEST_RE =
  /\b(ingest|import|index|update|scan|process|watch)\b[\s\S]{0,48}\b(docs?|documentation|markdown)\b/i;

const DOCS_FOLDER_RE =
  /\b(docs?|documentation)\s+folder\b|\bfolder\s+of\s+(docs?|documentation|markdown)\b/i;

const LIST_RE = /\b(list|show|what)\b[\s\S]{0,40}\b(docs?|documentation)\s+folders?\b/i;

export function parseDocsIngestIntent(text: string, sourceLabels: string[] = []): DocsIngestIntent | null {
  const t = text.trim();
  if (!t) return null;

  if (LIST_RE.test(t)) return { kind: "list" };

  const abs = t.match(/(?:^|[\s"`'])(\/[^\s"'`]+)/);
  const unixPath = abs?.[1];
  if (
    unixPath &&
    /\b(watch|ingest|index|add|scan|register)\b/i.test(t) &&
    /\b(docs?|documentation|folder|markdown)\b/i.test(t)
  ) {
    const label = labeledSource(t, sourceLabels);
    return { kind: "add", path: unixPath, label };
  }

  if (DOCS_INGEST_RE.test(t) || DOCS_FOLDER_RE.test(t) || /\bingest my docs\b/i.test(t)) {
    const source = labeledSource(t, sourceLabels) ?? namedSource(t, sourceLabels);
    return { kind: "run", source };
  }
  return null;
}

export function looksLikeDocsIngest(text: string): boolean {
  return parseDocsIngestIntent(text) != null;
}

function labeledSource(text: string, labels: string[]): string | undefined {
  const lower = text.toLowerCase();
  return labels.find((l) => l && lower.includes(l.toLowerCase()));
}

function namedSource(text: string, labels: string[]): string | undefined {
  const m = /\b(?:the|my)\s+([a-z][a-z0-9 _-]{1,40})\s+(?:docs?|documentation)\b/i.exec(text);
  if (!m?.[1]) return undefined;
  const hint = m[1].trim();
  return (
    labels.find((l) => l.toLowerCase() === hint.toLowerCase()) ??
    labels.find((l) => l.toLowerCase().includes(hint.toLowerCase())) ??
    hint
  );
}
