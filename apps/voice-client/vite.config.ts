import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { AccessToken } from "livekit-server-sdk";
import { defineConfig, type Plugin } from "vite";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

async function mintClientToken(opts: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
}): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, {
    identity: opts.identity,
    ttl: 60 * 60,
  });
  at.addGrant({
    roomJoin: true,
    room: opts.roomName,
    canPublish: true,
    canSubscribe: true,
  });
  return at.toJwt();
}

function tokenApiPlugin(): Plugin {
  return {
    name: "alfred-token-api",
    configureServer(server) {
      server.middlewares.use("/api/token", async (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        try {
          const apiKey = process.env.LIVEKIT_API_KEY;
          const apiSecret = process.env.LIVEKIT_API_SECRET;
          const url = process.env.LIVEKIT_URL;
          if (!apiKey || !apiSecret || !url) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error:
                  "Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in the repo .env",
              }),
            );
            return;
          }
          const room = process.env.LIVEKIT_ROOM ?? "alfred-dev";
          const identity = `alfred-client-${Math.random().toString(36).slice(2, 8)}`;
          const token = await mintClientToken({
            apiKey,
            apiSecret,
            roomName: room,
            identity,
          });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ url, room, identity, token }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
    },
  };
}

// Desktop hosts the built SPA at /voice/ (see apps/desktop-client). Standalone
// `pnpm client` keeps base "/" so http://localhost:5173/ still works.
const base = process.env.VOICE_CLIENT_BASE ?? "/";

export default defineConfig({
  base,
  plugins: [tokenApiPlugin()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
