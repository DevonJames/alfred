import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import {
  createLiveKitToken,
  dispatchLiveKitAgent,
  isLiveVoiceStack,
  liveAgentName,
  mintLiveRoomName,
} from "@alfred/livekit";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

async function main(): Promise<void> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    console.error("Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET");
    process.exitCode = 1;
    return;
  }
  const identity = process.argv[2] ?? "alfred-client";
  const room = mintLiveRoomName();
  const agentName = isLiveVoiceStack() ? liveAgentName() : undefined;
  const token = await createLiveKitToken({
    apiKey,
    apiSecret,
    roomName: room,
    identity,
    agentName,
  });
  if (agentName) {
    try {
      await dispatchLiveKitAgent({
        url,
        apiKey,
        apiSecret,
        roomName: room,
        agentName,
        metadata: JSON.stringify({ stack: "gpt-live", identity }),
      });
    } catch (err) {
      console.warn("[mint-token] agent dispatch failed:", err);
    }
  }
  console.log(
    JSON.stringify(
      {
        url,
        room,
        identity,
        token,
        ...(agentName
          ? { agentName, voiceStack: "live" }
          : { voiceStack: "cascade" }),
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
