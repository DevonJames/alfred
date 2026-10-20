const X_HTTP_LOAD_ERROR =
  "X refused to load the post (blocked, rate-limited, or logged out). Stay logged in as the ingest account and do not click Check session during a scan";

/** Playwright dumps are not useful in notes, briefing, or speech. */
export function sanitizeXIngestError(error: string | undefined): string {
  const raw = (error ?? "an unknown error").replace(/\s+/g, " ").trim();
  if (!raw) return "an unknown error";
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE|HTTP_RESPONSE_CODE_FAILURE/i.test(raw)) {
    return X_HTTP_LOAD_ERROR;
  }
  if (/has been closed|Target closed|browser has been closed/i.test(raw)) {
    return "the ingest browser was closed mid-scan. Wait for the scan to finish before checking the X session";
  }
  if (/page\.goto|Call log|net::ERR_/i.test(raw)) {
    return "the page could not be loaded";
  }
  if (/paywall/i.test(raw)) return "a paywall";
  if (/timeout/i.test(raw)) return "a timeout";
  if (/no transcript/i.test(raw)) return "no transcript";
  const short = raw.split(/ at Call log:| waiting until |:\s*Error:/i)[0]!.trim();
  if (short.length > 220) return `${short.slice(0, 217).trim()}…`;
  return short || "an unknown error";
}
