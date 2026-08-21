/** Heuristic: user asked to ingest a local documentation folder. */
export function looksLikeDocsIngestTask(text: string): boolean {
  const t = text.trim();
  if (/\b(list|show|what)\b[\s\S]{0,40}\b(docs?|documentation)\s+folders?\b/i.test(t)) return true;
  if (/\bingest my docs\b/i.test(t)) return true;
  if (/\b(ingest|import|index|update|scan|process|watch)\b[\s\S]{0,48}\b(docs?|documentation|markdown)\b/i.test(t)) {
    return true;
  }
  if (/\b(docs?|documentation)\s+folder\b/i.test(t) && /\b(ingest|watch|index|scan|update)\b/i.test(t)) {
    return true;
  }
  return false;
}
