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
    return `${alfredBase()}${normalized}`;
  }

  /** Strip proxy prefix so local path checks (e.g. /voice) still work. */
  function alfredPathname(pathname) {
    return pathname.replace(/^\/proxy\/[^/]+/, "") || "/";
  }

  global.alfredBase = alfredBase;
  global.alfredUrl = alfredUrl;
  global.alfredPathname = alfredPathname;
})(typeof window !== "undefined" ? window : globalThis);
