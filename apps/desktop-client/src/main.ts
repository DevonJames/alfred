/**
 * Alfred desktop client — local HTTP host + alfrd.net cloud-connect / relay.
 *
 * Usage:
 *   1. Set ALFRD_CLOUD_URL / ALFRD_RELAY_URL in repo-root .env (defaults to api.alfrd.net)
 *   2. pnpm desktop
 *   3. Open http://127.0.0.1:3000/ for the local UI hub (voice uplink, memory, …)
 *   4. Note Desktop Client ID + Claim Secret from logs (or GET /connect/info)
 *   5. Claim from alfrd.net account; mobile client discovers LAN → WAN → relay
 */
import { serve } from "@hono/node-server";
import { config as loadEnv } from "dotenv";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCloudConnect, stopCloudConnect } from "./lib/cloud-connect.js";
import { briefingRouter } from "./routes/briefing.js";
import { connectRouter } from "./routes/connect.js";
import { memoryRouter } from "./routes/memory.js";
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
  health: "/connect/health",
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
app.route("/memory", memoryRouter);
app.route("/api", tokenRouter);
app.route("/api", briefingRouter);
app.route("/voice", voiceRouter);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ALFRED desktop client listening on http://127.0.0.1:${info.port}`);
  console.log(`  UI hub:        http://127.0.0.1:${info.port}/`);
  console.log(`  Voice uplink:  http://127.0.0.1:${info.port}/voice/`);
  console.log(`  Memory ingest: http://127.0.0.1:${info.port}/memory/ingest`);
  console.log(`  Memory graph:  http://127.0.0.1:${info.port}/memory/graph`);
  console.log(`  Briefing:      http://127.0.0.1:${info.port}/api/briefing`);
  console.log(`  Memory due:    http://127.0.0.1:${info.port}/api/memory/due`);
  console.log(`  Cloud: ${process.env.ALFRD_CLOUD_URL ?? "https://api.alfrd.net"}`);
  console.log(`  Relay: ${process.env.ALFRD_RELAY_URL ?? "wss://api.alfrd.net"}`);
  console.log(`  Name:  ${process.env.DESKTOP_CLIENT_NAME ?? "Alfred"}`);
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

function shutdown(signal: string) {
  console.log(`\nShutting down (${signal})…`);
  stopCloudConnect();
  server.close(() => {
    process.exit(0);
  });
  // Force exit if close hangs
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
