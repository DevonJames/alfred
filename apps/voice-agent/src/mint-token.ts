import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { createLiveKitToken } from "@alfred/livekit";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

async function main(): Promise<void> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error("Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET");
    process.exitCode = 1;
    return;
  }
  const room = process.env.LIVEKIT_ROOM ?? "alfred-dev";
  const identity = process.argv[2] ?? "alfred-client";
  const token = await createLiveKitToken({
    apiKey,
    apiSecret,
    roomName: room,
    identity,
  });
  console.log(
    JSON.stringify(
      {
        url: process.env.LIVEKIT_URL,
        room,
        identity,
        token,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
