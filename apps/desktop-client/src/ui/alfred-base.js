/**
 * Path helpers when the desktop UI is served under /proxy/:serverId/…
 * Root-absolute URLs must stay under that prefix on api.alfrd.net.
 */
(function (global) {
  function alfredBase() {
    const match = global.location.pathname.match(/^(\/proxy\/[^/]+)/);
    return match ? match[1] : "";
  }

  function alfredUrl(path) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const base = alfredBase();
    // HTML served through /proxy/:id is rewritten to already include that
    // prefix. Prefixing again sends /agenda/board to a path that 404s.
    if (!base || normalized === base || normalized.startsWith(`${base}/`)) return normalized;
    return `${base}${normalized}`;
  }

  /** Strip proxy prefix so local path checks (e.g. /voice) still work. */
  function alfredPathname(pathname) {
    return pathname.replace(/^\/proxy\/[^/]+/, "") || "/";
  }

  global.alfredBase = alfredBase;
  global.alfredUrl = alfredUrl;
  global.alfredPathname = alfredPathname;
})(typeof window !== "undefined" ? window : globalThis);
