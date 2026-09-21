/**
 * AlfredBot local host — Chromium kiosk talks only to this process.
 *
 * Pairing, Wi-Fi, and LiveKit token mint stay here so credentials never live
 * in renderer storage. Conversation Core stays on the Mac.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "./env.js";
import { startConversationWatch } from "./conversation.js";
import { applyHeadPrefsOnBoot } from "./head.js";
import { createAlfredBotRouter } from "./routes.js";

const here = dirname(fileURLToPath(import.meta.url));
for (const envPath of [
  "/etc/alfredbot.env",
  resolve(process.cwd(), ".env"),
  resolve(here, ".env"),
  resolve(process.cwd(), "../../.env"),
]) {
  loadEnvFile(envPath);
}

const port = Number.parseInt(process.env.ALFREDBOT_PORT ?? "3200", 10);
const uiDir = [resolve(here, "dist-ui"), resolve(process.cwd(), "dist-ui"), resolve(here, "../../dist-ui")].find(
  (p) => existsSync(p),
);

const app = new Hono();
app.route("/", createAlfredBotRouter());

if (uiDir) {
  app.use("/assets/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use("/assets/*", serveStatic({ root: uiDir }));
  app.get("/", async (c) => {
    const html = await readFile(resolve(uiDir, "index.html"), "utf8");
    c.header("Cache-Control", "no-store");
    return c.html(html);
  });
} else {
  app.get("/", (c) =>
    c.text("AlfredBot UI is not built yet. Run `pnpm --filter @alfred/alfredbot build:ui`."),
  );
}

applyHeadPrefsOnBoot();
startConversationWatch();

const bind = process.env.ALFREDBOT_BIND ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname: bind }, (info) => {
  console.log(`AlfredBot listening on http://${bind}:${info.port}`);
  console.log(`  UI:     http://127.0.0.1:${info.port}/`);
  console.log(`  Status: http://127.0.0.1:${info.port}/api/status`);
  console.log(`  Claim:  show QR on the glass; scan it from the iPhone`);
  if (!uiDir) {
    console.warn("  dist-ui missing — run `pnpm --filter @alfred/alfredbot build:ui`");
  }
});
