/** Heuristic: user asked to ingest X.com content (notes inbox or a link). */
export function looksLikeXIngestTask(text: string): boolean {
  const t = text.trim();
  if (/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(t)) return true;
  if (/\bingest\b[\s\S]{0,48}\b(x|twitter|notes?)\b/i.test(t)) return true;
  if (/\b(go\s+)?pull\b[\s\S]{0,48}\b(x|twitter|link|post|article|thread)\b/i.test(t)) return true;
  return false;
}
