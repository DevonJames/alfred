/**
 * Serves the built voice-client SPA (waveform + transcript HUD).
 *
 * Build first: pnpm --filter @alfred/voice-client run build:desktop
 * Then: GET /voice/ → uplink UI (token via GET /api/token)
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

export const voiceRouter = new Hono();

const voiceClientDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../voice-client/dist",
);

function distReady(): boolean {
  return existsSync(path.join(voiceClientDist, "index.html"));
}

voiceRouter.get("/", async (c) => {
  if (!distReady()) {
    return c.html(
      `<!doctype html><html><body style="font:14px/1.4 system-ui;padding:2rem;max-width:36rem">
        <h1>Voice UI not built</h1>
        <p>From the repo root run:</p>
        <pre>pnpm --filter @alfred/voice-client run build:desktop</pre>
        <p>Then reload this page. Or use <code>pnpm desktop</code>, which builds automatically.</p>
      </body></html>`,
      503,
    );
  }
  const html = await readFile(path.join(voiceClientDist, "index.html"), "utf8");
  return c.html(html);
});

// serveStatic roots are resolved from process.cwd() (apps/desktop-client under pnpm).
const staticRoot = path.relative(process.cwd(), voiceClientDist) || ".";

voiceRouter.use(
  "/*",
  serveStatic({
    root: staticRoot,
    rewriteRequestPath: (p) => {
      // Hono may pass the full URL path or the mount-stripped path.
      if (p.startsWith("/voice/")) return p.slice("/voice".length);
      if (p === "/voice") return "/";
      return p;
    },
  }),
);
