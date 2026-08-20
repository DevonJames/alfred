const X_HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com"]);

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]);

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

function collectUrls(text: string, re: RegExp): string[] {
  if (!text) return [];
  const decoded = text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

/** Pull x.com / twitter.com / t.co URLs out of HTML or plain text. */
export function extractXUrls(text: string): string[] {
  return collectUrls(
    text,
    /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|t\.co)\/[^\s<>"'”)\]]+/gi,
  );
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

/** Handle from https://x.com/{handle}/status/{id} (not /i/status/...). */
export function handleFromXStatusUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "x.com" && host !== "twitter.com" && host !== "mobile.x.com") return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[1] === "status" && parts[0] && parts[0] !== "i") return parts[0];
  } catch {
    return undefined;
  }
  return undefined;
}

/** Archive / display URL: keep the handle, drop tracking (`?s=` / `&t=` / `&amp;t=`). */
export function archiveDisplayUrl(raw: string): string {
  if (isYouTubeUrl(raw)) return canonicalizeYouTubeUrl(raw);
  const handle = handleFromXStatusUrl(raw);
  const id = statusIdFromUrl(raw);
  if (handle && id) return `https://x.com/${handle}/status/${id}`;
  return canonicalizeInboxUrl(raw);
}

export function extractYouTubeUrls(text: string): string[] {
  return collectUrls(
    text,
    /https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"'”)\]]+/gi,
  );
}

export function isYouTubeUrl(url: string): boolean {
  try {
    return YT_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 11-char watch id, or undefined for playlists/channels. */
export function youtubeVideoIdFromUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\//, "").split("/")[0] ?? "";
    return /^[\w-]{11}$/.test(id) ? id : undefined;
  }
  if (host !== "youtube.com" && host !== "m.youtube.com") return undefined;
  const v = url.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = parts[0];
  const maybeId = parts[1];
  if (
    (kind === "shorts" || kind === "live" || kind === "embed" || kind === "v") &&
    maybeId &&
    /^[\w-]{11}$/.test(maybeId)
  ) {
    return maybeId;
  }
  return undefined;
}

export function isYouTubePlaylistOrChannelUrl(raw: string): boolean {
  if (!isYouTubeUrl(raw)) return false;
  if (youtubeVideoIdFromUrl(raw)) return false;
  try {
    const url = new URL(raw.trim());
    const path = url.pathname.replace(/\/+$/, "");
    if (url.searchParams.has("list") && !url.searchParams.get("v")) return true;
    if (path.startsWith("/playlist") || path.startsWith("/channel/") || path.startsWith("/@")) {
      return true;
    }
    if (path.startsWith("/c/") || path.startsWith("/user/")) return true;
  } catch {
    return true;
  }
  return true;
}

export function canonicalizeYouTubeUrl(raw: string): string {
  const id = youtubeVideoIdFromUrl(raw);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return raw.trim();
}

/** Canonical ledger key for X or YouTube inbox URLs. */
export function canonicalizeInboxUrl(raw: string): string {
  if (isYouTubeUrl(raw)) return canonicalizeYouTubeUrl(raw);
  return canonicalizeXUrl(raw);
}

export function extractInboxLinkUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...extractXUrls(text), ...extractYouTubeUrls(text)]) {
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "note";
}
