/**
 * Alfred desktop client — local HTTP host + alfrd.net cloud-connect / relay.
 *
 * Usage:
 *   1. Set ALFRD_CLOUD_URL / ALFRD_RELAY_URL in repo-root .env (defaults to api.alfrd.net)
 *   2. pnpm desktop
 *   3. Open http://127.0.0.1:3000/ for the local UI hub (voice uplink, memory, …)
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
import { apiMemoryRouter } from "./routes/api-memory.js";
import { briefingRouter } from "./routes/briefing.js";
import { connectRouter } from "./routes/connect.js";
import { conversationRouter } from "./routes/conversation.js";
import { memoryRouter } from "./routes/memory.js";
import { pairRouter } from "./routes/pair.js";
import { sessionRouter } from "./routes/session.js";
import { tokenRouter } from "./routes/token.js";
import { voiceRouter } from "./routes/voice.js";

// Load repo-root .env when started from apps/desktop-client.
loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

const port = Number(process.env.PORT ?? 3000);
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
  memoryDue: "/api/memory/due",
  token: "/api/token",
} as const;

app.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "home.html"), "utf8");
  return c.html(html);
});

app.get("/status", (c) => c.json(statusPayload));

app.route("/connect", connectRouter);
app.route("/pair", pairRouter);

// Legacy local voice UI token (unauthenticated). iOS uses /api/session/token.
app.route("/api", tokenRouter);

app.route("/api/session", sessionRouter);
app.route("/api/conversation", conversationRouter);
app.route("/api/memory", apiMemoryRouter);
app.route("/api", briefingRouter);

// Local browser UIs (ingest/graph) stay public; iOS uses authenticated /api/memory.
app.route("/memory", memoryRouter);

// Voice SPA assets stay public; token mint for SPA is /api/token above.
app.route("/voice", voiceRouter);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ALFRED desktop client listening on http://127.0.0.1:${info.port}`);
  console.log(`  UI hub:        http://127.0.0.1:${info.port}/`);
  console.log(`  Claim QR:      http://127.0.0.1:${info.port}/connect/claim`);
  console.log(`  Pair:          POST http://127.0.0.1:${info.port}/pair/request`);
  console.log(`  Session token: http://127.0.0.1:${info.port}/api/session/token`);
  console.log(`  Memory API:    http://127.0.0.1:${info.port}/api/memory`);
  console.log(`  Voice uplink:  http://127.0.0.1:${info.port}/voice/`);
  console.log(`  Memory ingest: http://127.0.0.1:${info.port}/memory/ingest`);
  console.log(`  Memory graph:  http://127.0.0.1:${info.port}/memory/graph`);
  console.log(`  Briefing:      http://127.0.0.1:${info.port}/api/briefing`);
  console.log(`  Cloud: ${process.env.ALFRD_CLOUD_URL ?? "https://api.alfrd.net"}`);
  console.log(`  Relay: ${process.env.ALFRD_RELAY_URL ?? "wss://api.alfrd.net"}`);
  console.log(`  Name:  ${process.env.DESKTOP_CLIENT_NAME ?? "Alfred"}`);
  console.log(`  Voice agent: run \`pnpm voice\` separately for Talk audio`);
});

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
setTimeout(() => {
  startCloudConnect(port).catch((err) => {
    console.error("[CloudConnect] Startup failed:", err);
  });
}, 3_000);

const stopXIngest = startXIngestScheduler();

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
