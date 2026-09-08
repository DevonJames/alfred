/**
 * Alfred desktop client — local HTTP host + alfrd.net cloud-connect / relay.
 *
 * Usage:
 *   1. Set ALFRD_CLOUD_URL / ALFRD_RELAY_URL in repo-root .env (defaults to api.alfrd.net)
 *   2. pnpm desktop
 *   3. Open http://127.0.0.1:3000/ for the app shell (Talk, graph, ingest, claim)
 *   4. Open http://127.0.0.1:3000/connect/claim for QR + claim secret
 *   5. Claim from alfrd.net account; mobile client discovers LAN → WAN → relay
 *   6. Pair device (PIN), then call /api/session/token and /api/memory/*
 *   7. For voice: also run `pnpm voice` so alfred-agent joins LiveKit
 */
import { serve } from "@hono/node-server";
import { config as loadEnv } from "dotenv";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCloudConnect, stopCloudConnect } from "./lib/cloud-connect.js";
import { startXIngestScheduler } from "./lib/x-ingest-schedule.js";
import { sidecarHostname, sidecarPort, isSidecarMode } from "./lib/sidecar-mode.js";
import { sidecarRuntimeReady, warmupSidecarMemory } from "./lib/text-session.js";
import { apiMemoryRouter } from "./routes/api-memory.js";
import { briefingRouter } from "./routes/briefing.js";
import { briefingUiRouter } from "./routes/briefing-ui.js";
import { connectRouter } from "./routes/connect.js";
import { conversationRouter } from "./routes/conversation.js";
import { loadNoteJobs } from "./lib/notes/jobs.js";
import { resumeInterruptedNoteJobs } from "./lib/notes/service.js";
import { resolveFfmpeg, resolveFfprobe } from "./lib/notes/audio-chunks.js";
import { pruneStaleNoteUploads, resumeAssemblingNoteUploads } from "./lib/notes/uploads.js";
import { apiNotesRouter } from "./routes/api-notes.js";
import { memoryRouter } from "./routes/memory.js";
import { notesUiRouter } from "./routes/notes-ui.js";
import { pairRouter } from "./routes/pair.js";
import { sessionRouter } from "./routes/session.js";
import { tokenRouter } from "./routes/token.js";
import { voiceRouter } from "./routes/voice.js";

// Load repo-root .env when started from apps/desktop-client.
loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

const port = sidecarPort();
const hostname = sidecarHostname();
const sidecar = isSidecarMode();
const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "ui");

const app = new Hono();

const statusPayload = {
  service: "alfred-desktop-client",
  status: "ok",
  ui: "/",
  voice: "/voice/",
  connect: "/connect/info",
  claim: "/connect/claim",
  claimQr: "/connect/claim.png",
  health: "/connect/health",
  pair: "/pair/request",
  sessionToken: "/api/session/token",
  conversationTurn: "/api/conversation/turn",
  memoryApi: "/api/memory",
  memoryIngest: "/memory/ingest",
  memoryGraph: "/memory/graph",
  briefing: "/api/briefing",
  briefingPrefs: "/briefing",
  notes: "/notes",
  notesApi: "/api/notes",
  memoryDue: "/api/memory/due",
  token: "/api/token",
} as const;

app.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "home.html"), "utf8");
  return c.html(html);
});

app.get("/alfred-base.js", async (c) => {
  const js = await readFile(resolve(uiDir, "alfred-base.js"), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
});

app.get("/shell.js", async (c) => {
  const js = await readFile(resolve(uiDir, "shell.js"), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
});

app.get("/embed-bridge.js", async (c) => {
  const js = await readFile(resolve(uiDir, "embed-bridge.js"), "utf8");
  return c.body(js, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
});

app.get("/status", (c) =>
  c.json({
    ...statusPayload,
    sidecar,
    service: sidecar ? "alfred-conversation-sidecar" : statusPayload.service,
  }),
);

app.get("/health", async (c) => {
  const runtime = sidecarRuntimeReady();
  let memory: { ok: boolean; path?: string; error?: string } = { ok: false };
  try {
    const warmed = await warmupSidecarMemory();
    memory = { ok: warmed.ok, path: warmed.path };
  } catch (err) {
    memory = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const ready = memory.ok;
  return c.json(
    {
      status: ready ? "ok" : "degraded",
      sidecar,
      openaiConfigured: runtime.openai,
      sessions: runtime.sessions,
      memory,
      timestamp: new Date().toISOString(),
    },
    ready ? 200 : 503,
  );
});

app.route("/connect", connectRouter);
app.route("/pair", pairRouter);

// Legacy local voice UI token (unauthenticated). iOS uses /api/session/token.
app.route("/api", tokenRouter);

app.route("/api/session", sessionRouter);
app.route("/api/conversation", conversationRouter);
app.route("/api/memory", apiMemoryRouter);
app.route("/api/notes", apiNotesRouter);
app.route("/api", briefingRouter);

// Local Daily Brief preferences UI (public, like ingest/claim).
app.route("/briefing", briefingUiRouter);
app.route("/notes", notesUiRouter);

// Local browser UIs (ingest/graph) stay public; iOS uses authenticated /api/memory.
app.route("/memory", memoryRouter);

// Voice SPA assets stay public; token mint for SPA is /api/token above.
app.route("/voice", voiceRouter);

const LONG_REQUEST_MS = 3 * 60 * 60 * 1000;

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  if (sidecar) {
    console.log(`ALFRED conversation sidecar listening on http://${host}:${info.port}`);
    console.log(`  Health:         GET  http://${host}:${info.port}/health`);
    console.log(`  Conversation:   POST http://${host}:${info.port}/api/conversation/turn`);
    console.log(`  Memory cards:   GET  http://${host}:${info.port}/api/memory/cards`);
    console.log("  Cloud connect:  disabled (sidecar mode)");
    return;
  }
  console.log(`ALFRED desktop client listening on http://127.0.0.1:${info.port}`);
  console.log(`  UI hub:        http://127.0.0.1:${info.port}/`);
  console.log(`  Claim QR:      http://127.0.0.1:${info.port}/connect/claim`);
  console.log(`  Pair:          POST http://127.0.0.1:${info.port}/pair/request`);
  console.log(`  Session token: http://127.0.0.1:${info.port}/api/session/token`);
  console.log(`  Memory API:    http://127.0.0.1:${info.port}/api/memory`);
  console.log(`  Voice uplink:  http://127.0.0.1:${info.port}/voice/`);
  console.log(`  Memory ingest: http://127.0.0.1:${info.port}/memory/ingest`);
  console.log(`  Memory graph:  http://127.0.0.1:${info.port}/memory/graph`);
  console.log(`  Graph (beta):  http://127.0.0.1:${info.port}/memory/graph-beta`);
  console.log(`  Briefing:      http://127.0.0.1:${info.port}/api/briefing`);
  console.log(`  Brief prefs:   http://127.0.0.1:${info.port}/briefing`);
  console.log(`  Notes:         http://127.0.0.1:${info.port}/notes`);
  console.log(`  Cloud: ${process.env.ALFRD_CLOUD_URL ?? "https://api.alfrd.net"}`);
  console.log(`  Relay: ${process.env.ALFRD_RELAY_URL ?? "wss://api.alfrd.net"}`);
  console.log(`  Name:  ${process.env.DESKTOP_CLIENT_NAME ?? "Alfred"}`);
  console.log(`  Voice agent: run \`pnpm voice\` separately for Talk audio`);
});

if ("requestTimeout" in server) {
  server.requestTimeout = LONG_REQUEST_MS;
  server.timeout = LONG_REQUEST_MS;
  server.headersTimeout = 10 * 60 * 1000;
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use. Stop the other process or set PORT=… (e.g. PORT=3010 pnpm desktop).`,
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

// Match alfred-home: register after a short delay so the HTTP listener is ready.
if (!sidecar) {
  setTimeout(() => {
    startCloudConnect(port).catch((err) => {
      console.error("[CloudConnect] Startup failed:", err);
    });
  }, 3_000);
} else if (process.env.ALFRD_CLOUD_DISABLED !== "true") {
  process.env.ALFRD_CLOUD_DISABLED = "true";
  console.log("[CloudConnect] Forced off in ALFRED_SIDECAR_MODE");
}

const stopXIngest = startXIngestScheduler();
void loadNoteJobs()
  .then(() => resumeInterruptedNoteJobs())
  .catch((err) => console.error("[notes] resume failed:", err));
void pruneStaleNoteUploads();
void resumeAssemblingNoteUploads();
void warnNotesRuntime();

async function warnNotesRuntime(): Promise<void> {
  const ffmpeg = await resolveFfmpeg();
  const ffprobe = await resolveFfprobe();
  if (ffmpeg) console.log(`[notes] ffmpeg: ${ffmpeg}`);
  else {
    console.warn(
      "[notes] ffmpeg not found. Long recordings will fail OpenAI's 25 MB limit. Install with `brew install ffmpeg`.",
    );
  }
  if (!ffprobe) console.warn("[notes] ffprobe not found. Duration probes will be skipped.");
  if (!process.env.VOICE_STT_URL && !process.env.OPENAI_API_KEY) {
    console.warn("[notes] No VOICE_STT_URL or OPENAI_API_KEY — transcription will fail.");
  }
  if (!process.env.GROK_API_KEY && !process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY) {
    console.warn("[notes] No GROK_API_KEY / XAI_API_KEY / OPENAI_API_KEY — summaries will be empty.");
  }
}

function shutdown(signal: string) {
  console.log(`\nShutting down (${signal})…`);
  stopXIngest();
  stopCloudConnect();
  server.close(() => {
    process.exit(0);
  });
  // Force exit if close hangs
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
