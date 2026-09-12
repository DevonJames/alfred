/**
 * When a desktop page is hosted inside the app shell iframe, keep in-app
 * links from navigating the iframe (which would nest the shell or kill voice).
 */
(function embedBridge() {
  if (window.parent === window) return;

  const CHANNEL = "alfred.shell";

  function localPath(pathname) {
    return typeof alfredPathname === "function" ? alfredPathname(pathname) : pathname;
  }

  function screenFromPath(pathname) {
    const path = localPath(pathname);
    if (path === "/" || path === "") return "voice";
    if (path.startsWith("/voice")) return "voice";
    if (path.startsWith("/briefing") && !pathname.includes(".")) return "brief";
    if (path === "/memory/graph-beta" || path.startsWith("/memory/graph-beta/")) return "graphBeta";
    if (path === "/memory/graph" || path.startsWith("/memory/graph/")) return "graph";
    if (path === "/vector-explorer" || path.startsWith("/vector-explorer/")) return "vectors";
    if (path.startsWith("/memory/ingest")) return "ingest";
    if (path.startsWith("/notes") && !pathname.includes(".")) return "notes";
    if (path.startsWith("/connect/claim") && !pathname.includes(".")) return "claim";
    return null;
  }

  function requestNavigate(screen) {
    window.parent.postMessage(
      { channel: CHANNEL, type: "navigate", screen },
      window.location.origin,
    );
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || !anchor.href) return;
      let parsed;
      try {
        parsed = new URL(anchor.href, window.location.origin);
      } catch {
        return;
      }
      if (parsed.origin !== window.location.origin) return;
      const screen = screenFromPath(parsed.pathname);
      if (!screen) return;
      event.preventDefault();
      requestNavigate(screen);
    },
    true,
  );

  window.alfredRequestShellNavigate = requestNavigate;
})();
