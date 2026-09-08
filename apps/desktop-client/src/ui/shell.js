const CHANNEL = "alfred.shell";

/** @typedef {"voice" | "brief" | "notes" | "graph" | "graphBeta" | "ingest" | "claim"} Screen */

const SCREENS = {
  voice: { title: "Talk", src: null },
  brief: { title: "Brief", src: "/briefing" },
  notes: { title: "Notes", src: "/notes" },
  graph: { title: "Graph", src: "/memory/graph" },
  graphBeta: { title: "Graph (beta)", src: "/memory/graph-beta" },
  ingest: { title: "Ingest", src: "/memory/ingest" },
  claim: { title: "Claim", src: "/connect/claim" },
};

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
const levels = new Array(48).fill(0);
let pipRaf = 0;

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

function screenFromHash() {
  const raw = (location.hash || "#voice").replace(/^#/, "").toLowerCase();
  if (raw === "graphbeta" || raw === "graph-beta") return "graphBeta";
  if (raw === "graph" || raw === "ingest" || raw === "claim" || raw === "voice" || raw === "brief" || raw === "notes")
    return raw;
  return "voice";
}

function setHash(next) {
  const hash = `#${next}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function applyScreen(next, opts = {}) {
  const { persistHash = true } = opts;
  screen = next;
  if (persistHash) setHash(next);

  for (const btn of nav.querySelectorAll("[data-screen]")) {
    btn.classList.toggle("active", btn.dataset.screen === next);
  }

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
      (next === "graphBeta" && isGraphBetaPath(current)) ||
      (next === "graph" && isClassicGraphPath(current)) ||
      (next === "ingest" && current.startsWith("/memory/ingest")) ||
      (next === "claim" && current.startsWith("/connect/claim"));
    if (!already && src) contentFrame.src = url(src);
  }

  updatePipVisibility();
}

function updatePipVisibility() {
  const show = voiceLinked && screen !== "voice";
  pip.hidden = !show;
  pip.classList.toggle("speaking", voiceSpeaking);
  pipDot.classList.toggle("live", voiceLinked && !voiceSpeaking);
  pipDot.classList.toggle("speaking", voiceSpeaking);
  if (show && !pipRaf) drawPip();
  if (!show && pipRaf) {
    cancelAnimationFrame(pipRaf);
    pipRaf = 0;
  }
}

function pushLevel(rms) {
  levels.shift();
  levels.push(Math.min(1, rms * 4));
}

function drawPip() {
  const canvas = pipCanvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const mid = h / 2;
  const barW = w / levels.length;
  for (let i = 0; i < levels.length; i++) {
    const mag = levels[i] ?? 0;
    const bh = Math.max(1.5, mag * (h * 0.42));
    ctx.fillStyle = voiceSpeaking
      ? `rgba(255, 179, 71, ${0.25 + mag * 0.65})`
      : `rgba(61, 255, 196, ${0.18 + mag * 0.55})`;
    ctx.fillRect(i * barW + 0.6, mid - bh, barW - 1.2, bh * 2);
  }

  ctx.strokeStyle = "rgba(215, 246, 255, 0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  if (!pip.hidden) pipRaf = requestAnimationFrame(drawPip);
}

function onShellMessage(event) {
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;

  if (data.type === "navigate" && data.screen in SCREENS) {
    applyScreen(data.screen);
    return;
  }

  if (data.type === "state") {
    voiceLinked = Boolean(data.linked);
    voiceSpeaking = Boolean(data.speaking);
    if (typeof data.rms === "number") pushLevel(data.rms);
    if (typeof data.caption === "string" && data.caption.trim()) {
      pipCaption.textContent = data.caption.trim();
    } else if (!voiceLinked) {
      pipCaption.textContent = "Voice idle";
    }
    updatePipVisibility();
  }
}

nav.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-screen]");
  if (!btn || !btn.dataset.screen) return;
  applyScreen(/** @type {Screen} */ (btn.dataset.screen));
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
    else if (path.startsWith("/memory/ingest")) applyScreen("ingest", { persistHash: true });
    else if (path.startsWith("/connect/claim")) applyScreen("claim", { persistHash: true });
    else if (path === "/" || path === "") applyScreen("voice");
  } catch {
    /* cross-origin — ignore */
  }
});

voiceFrame.src = url("/voice/");
applyScreen(screenFromHash());
