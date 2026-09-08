/**
 * Smoke-verify LiveKit agent auto-rejoin without restarting the whole stack.
 *
 * 1. Confirm alfred-agent is in the room
 * 2. Kick the agent via Room Service (simulates sleep disconnect)
 * 3. Wait for auto-reconnect and confirm presence again
 *
 * Usage (repo root, .env loaded):
 *   pnpm exec tsx scripts/verify-livekit-reconnect.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { RoomServiceClient } from "livekit-server-sdk";
import { isAgentInRoom } from "../packages/livekit/src/agent-presence.ts";

loadEnv({ path: resolve(process.cwd(), ".env") });

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const roomName = process.env.LIVEKIT_ROOM ?? "alfred-dev";
const identity = process.env.LIVEKIT_IDENTITY ?? "alfred-agent";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!url || !apiKey || !apiSecret) {
    console.error("Missing LIVEKIT_* in .env");
    process.exit(1);
  }

  const opts = { url, apiKey, apiSecret, roomName, identity };
  const before = await isAgentInRoom(opts);
  console.log(`[verify] agentPresent before kick: ${before}`);
  if (!before) {
    console.error(
      "[verify] FAIL: alfred-agent not in room. Start `make alfred` on cursor/fix-idle-voice-reconnect first.",
    );
    process.exit(2);
  }

  const host = url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  const svc = new RoomServiceClient(host, apiKey, apiSecret);
  console.log(`[verify] removing participant ${identity} from ${roomName}...`);
  await svc.removeParticipant(roomName, identity);

  // Give disconnect a moment to land, then wait for auto-rejoin (backoff starts at 1s).
  await sleep(1500);
  let rejoined = false;
  for (let i = 0; i < 30; i++) {
    rejoined = await isAgentInRoom(opts);
    console.log(`[verify] poll ${i + 1}/30 agentPresent=${rejoined}`);
    if (rejoined) break;
    await sleep(1000);
  }

  if (!rejoined) {
    console.error("[verify] FAIL: agent did not rejoin within ~30s");
    process.exit(3);
  }
  console.log("[verify] PASS: agent auto-rejoined after kick");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
