const X_HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com"]);

const TRACKING_PARAMS = new Set([
  "s",
  "t",
  "ref_src",
  "ref_url",
  "src",
  "cxt",
  "cn",
  "refsrc",
]);

/** Pull x.com / twitter.com / t.co URLs out of HTML or plain text. */
export function extractXUrls(text: string): string[] {
  if (!text) return [];
  const decoded = text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const re = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|t\.co)\/[^\s<>"'”)\]]+/gi;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const m of decoded.matchAll(re)) {
    const raw = (m[0] ?? "").replace(/[.,;:!?]+$/, "");
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(raw);
  }
  return found;
}

export function isXUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return X_HOSTS.has(host) || host === "t.co";
  } catch {
    return false;
  }
}

/**
 * Canonical form for ledger / identity:
 * - twitter.com → x.com
 * - status URLs collapse to https://x.com/i/status/{id}
 * - tracking query params stripped
 */
export function canonicalizeXUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "t.co") {
    return `https://t.co${url.pathname}`;
  }
  if (host !== "x.com" && host !== "twitter.com" && host !== "mobile.x.com") {
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  const statusMatch = path.match(/\/status(?:es)?\/(\d+)/);
  if (statusMatch?.[1]) {
    return `https://x.com/i/status/${statusMatch[1]}`;
  }
  const articleMatch = path.match(/\/i\/article\/([^/]+)/);
  if (articleMatch?.[1]) {
    return `https://x.com/i/article/${articleMatch[1]}`;
  }

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
  }
  const qs = url.searchParams.toString();
  return `https://x.com${path}${qs ? `?${qs}` : ""}`;
}

export function statusIdFromUrl(url: string): string | undefined {
  const m = canonicalizeXUrl(url).match(/\/status\/(\d+)/);
  return m?.[1];
}

export function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "note";
}
