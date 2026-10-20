const CHANNEL = "alfred.shell";

/** @typedef {"voice" | "brief" | "notes" | "graph" | "graphBeta" | "vectors" | "ingest" | "claim" | "gateway" | "agenda" | "reminders" | "weeklyPlan" | "medicine"} Screen */

const SCREENS = {
  voice: { title: "Talk", src: null },
  brief: { title: "Briefing", src: "/briefing" },
  notes: { title: "Notes", src: "/notes" },
  gateway: { title: "Gateway", src: "/gateway" },
  agenda: { title: "Agenda", src: "/agenda" },
  weeklyPlan: { title: "Weekly plan", src: "/agenda/standard-plan" },
  medicine: { title: "Medicine", src: "/medicine" },
  reminders: { title: "Reminders", src: "/reminders" },
  graph: { title: "Graph", src: "/memory/graph" },
  graphBeta: { title: "Graph (beta)", src: "/memory/graph-beta" },
  vectors: { title: "Vector Explorer", src: "/vector-explorer" },
  ingest: { title: "Ingest", src: "/memory/ingest" },
  claim: { title: "Claim", src: "/connect/claim" },
};

const MEMORY_SCREENS = new Set(["graph", "graphBeta", "vectors", "ingest"]);
const SETTINGS_SCREENS = new Set(["weeklyPlan", "medicine", "brief", "gateway", "notes", "claim"]);

const nav = document.getElementById("shell-nav");
const voiceFrame = document.getElementById("voice-frame");
const contentFrame = document.getElementById("content-frame");
const pip = document.getElementById("voice-pip");
const pipCanvas = document.getElementById("pip-wave");
const pipCaption = document.getElementById("pip-caption");
const pipDot = document.getElementById("pip-dot");

/** @type {Screen} */
let screen = "voice";
let voiceLinked = false;
let voiceSpeaking = false;
let voiceMuted = false;
let pipSurface = null;

function url(path) {
  return typeof alfredUrl === "function" ? alfredUrl(path) : path;
}

function localPath(pathname) {
  return typeof alfredPathname === "function" ? alfredPathname(pathname) : pathname;
}

function isClassicGraphPath(path) {
  return path === "/memory/graph" || path.startsWith("/memory/graph/");
}

function isGraphBetaPath(path) {
  return path === "/memory/graph-beta" || path.startsWith("/memory/graph-beta/");
}

function isVectorExplorerPath(path) {
  return path === "/vector-explorer" || path.startsWith("/vector-explorer/");
}

function screenFromHash() {
  const raw = (location.hash || "#voice").replace(/^#/, "").toLowerCase();
  if (raw === "graphbeta" || raw === "graph-beta") return "graphBeta";
  if (raw === "vectors" || raw === "vector" || raw === "vector-explorer") return "vectors";
  if (raw === "weeklyplan" || raw === "weekly-plan") return "weeklyPlan";
  if (raw === "medicine" || raw === "medicines" || raw === "supplements") return "medicine";
  if (raw === "graph" || raw === "ingest" || raw === "claim" || raw === "voice" || raw === "brief" || raw === "notes" || raw === "gateway" || raw === "agenda" || raw === "reminders")
    return raw;
  return "voice";
}

function setHash(next) {
  const hash = `#${next}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function closeMenus() {
  for (const menu of nav.querySelectorAll(".nav-menu")) {
    menu.classList.remove("open");
    const trigger = menu.querySelector(".nav-menu-trigger");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }
}

function syncNavActive(next) {
  for (const btn of nav.querySelectorAll("[data-screen]")) {
    btn.classList.toggle("active", btn.dataset.screen === next);
  }
  for (const menu of nav.querySelectorAll(".nav-menu")) {
    const kind = menu.dataset.menu;
    const active =
      (kind === "memory" && MEMORY_SCREENS.has(next)) ||
      (kind === "settings" && SETTINGS_SCREENS.has(next));
    menu.classList.toggle("has-active", active);
  }
}

/** Only a graph page URL may replace the iframe address, so a node link survives the shell. */
function graphNodeHref(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "";
  const path = localPath(raw.split("?")[0].split("#")[0]);
  if (path !== "/memory/graph") return "";
  return raw.split("#")[0];
}

function applyScreen(next, opts = {}) {
  const { persistHash = true, force = false, href = "" } = opts;
  const previous = screen;
  screen = next;
  if (persistHash) setHash(next);
  closeMenus();
  syncNavActive(next);

  const onVoice = next === "voice";
  contentFrame.classList.toggle("is-hidden", onVoice);
  voiceFrame.classList.toggle("is-front", onVoice);
  document.body.dataset.screen = next;

  if (!onVoice) {
    const src = SCREENS[next].src;
    const current = (() => {
      try {
        return localPath(contentFrame.contentWindow?.location.pathname ?? "");
      } catch {
        return "";
      }
    })();
    const already =
      (next === "brief" && current.startsWith("/briefing")) ||
      (next === "notes" && current.startsWith("/notes")) ||
      (next === "gateway" && current.startsWith("/gateway")) ||
      (next === "weeklyPlan" && current.startsWith("/agenda/standard-plan")) ||
      (next === "medicine" && current.startsWith("/medicine")) ||
      (next === "agenda" && current.startsWith("/agenda") && !current.startsWith("/agenda/standard-plan")) ||
      (next === "reminders" && current.startsWith("/reminders")) ||
      (next === "graphBeta" && isGraphBetaPath(current)) ||
      (next === "graph" && isClassicGraphPath(current)) ||
      (next === "vectors" && isVectorExplorerPath(current)) ||
      (next === "ingest" && current.startsWith("/memory/ingest")) ||
      (next === "claim" && current.startsWith("/connect/claim"));
    const canonical = src ? localPath(src) : "";
    const onCanonical = !canonical || current === canonical || current === `${canonical}/`;
    const frameSrc = href || src;
    if (frameSrc && (href || !already || (force && !onCanonical))) contentFrame.src = url(frameSrc);
  }

  updatePipVisibility();

  // Agenda ear steals Talk turns into the calendar LLM — clear whenever we
  // leave Agenda, and also whenever Talk/Voice is focused (in case a prior
  // clear was missed while the ear was still armed).
  if ((previous === "agenda" && next !== "agenda") || next === "talk" || next === "voice") {
    void fetch(url("/agenda/ear"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
  }
  if (next === "agenda" && contentFrame.contentWindow) {
    contentFrame.contentWindow.postMessage({ channel: CHANNEL, type: "visible" }, location.origin);
    postVoice();
  }
}

function updatePipVisibility() {
  const show = voiceLinked && screen !== "voice" && screen !== "agenda";
  pip.hidden = !show;
  pip.classList.toggle("speaking", voiceSpeaking);
  pipDot.classList.toggle("live", voiceLinked && !voiceSpeaking);
  pipDot.classList.toggle("speaking", voiceSpeaking);
}

function postVoice() {
  if (screen !== "agenda" || !contentFrame.contentWindow) return;
  contentFrame.contentWindow.postMessage(
    {
      channel: CHANNEL,
      type: "voice",
      linked: voiceLinked,
      speaking: voiceSpeaking,
      muted: voiceMuted,
    },
    location.origin,
  );
}

function sendPipSurface() {
  if (!voiceFrame.contentWindow || typeof pipCanvas.transferControlToOffscreen !== "function") return;
  if (!pipSurface) {
    const dpr = window.devicePixelRatio || 1;
    pipSurface = {
      canvas: pipCanvas.transferControlToOffscreen(),
      width: Math.max(1, Math.floor((pipCanvas.clientWidth || 280) * dpr)),
      height: Math.max(1, Math.floor(44 * dpr)),
    };
  }
  if (pipSurface.sent) return;
  pipSurface.sent = true;
  voiceFrame.contentWindow.postMessage(
    {
      channel: CHANNEL,
      type: "wave-surface",
      id: "pip",
      canvas: pipSurface.canvas,
      width: pipSurface.width,
      height: pipSurface.height,
    },
    location.origin,
    [pipSurface.canvas],
  );
}

function onShellMessage(event) {
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;

  if (data.type === "navigate" && data.screen in SCREENS) {
    const href = data.screen === "graph" ? graphNodeHref(data.href) : "";
    applyScreen(data.screen, href ? { href } : {});
    return;
  }

  if (data.type === "talk-focus") {
    applyScreen("voice");
    const send = () => {
      if (voiceFrame.contentWindow) {
        voiceFrame.contentWindow.postMessage(data, location.origin);
      }
    };
    send();
    window.setTimeout(send, 400);
    return;
  }

  if ((data.type === "ask" || data.type === "listen" || data.type === "voice-cmd" || data.type === "wave-size") && voiceFrame.contentWindow && event.source !== voiceFrame.contentWindow) {
    voiceFrame.contentWindow.postMessage(data, location.origin);
    return;
  }

  if (data.type === "wave-surface" && data.canvas && voiceFrame.contentWindow && event.source !== voiceFrame.contentWindow) {
    voiceFrame.contentWindow.postMessage(data, location.origin, [data.canvas]);
    return;
  }

  if ((data.type === "ask-failed" || data.type === "listen-failed") && contentFrame.contentWindow) {
    contentFrame.contentWindow.postMessage(data, location.origin);
    return;
  }

  if (data.type === "wave-ready" && event.source === voiceFrame.contentWindow) {
    sendPipSurface();
    return;
  }

  if (data.type === "turn" && event.source === voiceFrame.contentWindow && screen === "agenda" && contentFrame.contentWindow) {
    contentFrame.contentWindow.postMessage(data, location.origin);
    return;
  }

  if (data.type === "state") {
    const wasLinked = voiceLinked;
    const wasSpeaking = voiceSpeaking;
    const wasMuted = voiceMuted;
    voiceLinked = Boolean(data.linked);
    voiceSpeaking = Boolean(data.speaking);
    voiceMuted = Boolean(data.muted);
    if (typeof data.caption === "string" && data.caption.trim()) {
      pipCaption.textContent = data.caption.trim();
    } else if (!voiceLinked) {
      pipCaption.textContent = "Voice idle";
    }
    updatePipVisibility();
    if (wasLinked !== voiceLinked || wasSpeaking !== voiceSpeaking || wasMuted !== voiceMuted) postVoice();
  }
}

nav.addEventListener("click", (event) => {
  const trigger = event.target.closest(".nav-menu-trigger");
  if (trigger) {
    const menu = trigger.closest(".nav-menu");
    if (!menu) return;
    const willOpen = !menu.classList.contains("open");
    closeMenus();
    if (willOpen) {
      menu.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
    }
    return;
  }

  const btn = event.target.closest("[data-screen]");
  if (!btn || !btn.dataset.screen) return;
  applyScreen(/** @type {Screen} */ (btn.dataset.screen), { force: true });
});

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("#shell-nav .nav-menu")) return;
  closeMenus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});

pip.addEventListener("click", () => {
  applyScreen("voice");
});

window.addEventListener("hashchange", () => {
  applyScreen(screenFromHash(), { persistHash: false });
});

window.addEventListener("message", onShellMessage);

contentFrame.addEventListener("load", () => {
  try {
    const href = contentFrame.contentWindow?.location.href ?? "";
    if (!href || href === "about:blank") return;
    const path = localPath(contentFrame.contentWindow?.location.pathname ?? "");
    if (path.startsWith("/voice")) {
      applyScreen("voice");
      return;
    }
    if (path.startsWith("/briefing")) applyScreen("brief", { persistHash: true });
    else if (isGraphBetaPath(path)) applyScreen("graphBeta", { persistHash: true });
    else if (isClassicGraphPath(path)) applyScreen("graph", { persistHash: true });
    else if (isVectorExplorerPath(path)) applyScreen("vectors", { persistHash: true });
    else if (path.startsWith("/memory/ingest")) applyScreen("ingest", { persistHash: true });
    else if (path.startsWith("/connect/claim")) applyScreen("claim", { persistHash: true });
    else if (path.startsWith("/notes")) applyScreen("notes", { persistHash: true });
    else if (path.startsWith("/gateway")) applyScreen("gateway", { persistHash: true });
    else if (path === "/agenda/standard-plan" || path.startsWith("/agenda/standard-plan/")) applyScreen("weeklyPlan", { persistHash: true });
    else if (path === "/medicine" || path.startsWith("/medicine/")) applyScreen("medicine", { persistHash: true });
    else if (path.startsWith("/agenda")) applyScreen("agenda", { persistHash: true });
    else if (path.startsWith("/reminders")) applyScreen("reminders", { persistHash: true });
    else if (path === "/" || path === "") applyScreen("voice");
  } catch {
    /* cross-origin — ignore */
  }
});

voiceFrame.src = url("/voice/");
applyScreen(screenFromHash());
