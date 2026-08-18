/** Heuristic: user asked to ingest X.com or YouTube content (notes inbox or a link). */
export function looksLikeXIngestTask(text: string): boolean {
  const t = text.trim();
  if (/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(t)) return true;
  if (/https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(t)) return true;
  if (/\bingest\b[\s\S]{0,48}\b(x|twitter|youtube|yt|notes?)\b/i.test(t)) return true;
  if (/\b(go\s+)?pull\b[\s\S]{0,48}\b(x|twitter|youtube|yt|link|post|article|thread|video)\b/i.test(t)) {
    return true;
  }
  return false;
}
