/**
 * One-time Speech Engine resource for VOICE=live2.
 *
 *   pnpm speech-engine:create
 *
 * Prints ELEVENLABS_SPEECH_ENGINE_ID. Default URL is the alfrd.net speech relay
 * for this desktop. Deploy alfrd-cloud before ElevenLabs can connect.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

const DEFAULT_VOICE_ID = "qXcNpxDCD6dKvASibF0r";

async function defaultSpeechUrl(): Promise<string | undefined> {
  const explicit = process.env.PUBLIC_WS_URL?.trim();
  if (explicit) return explicit;
  try {
    const raw = await readFile(resolve(process.cwd(), "../../data/desktop-client/identity.json"), "utf8");
    const id = (JSON.parse(raw) as { desktopClientId?: string }).desktopClientId?.trim();
    if (!id) return undefined;
    const relay = (process.env.ALFRD_RELAY_URL ?? "wss://api.alfrd.net").replace(/\/$/, "");
    return `${relay}/speech/${id}/ws`;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || process.env.ELEVEN_API_KEY?.trim();
  const wsUrl = await defaultSpeechUrl();
  if (!apiKey) throw new Error("Set ELEVENLABS_API_KEY");
  if (!wsUrl?.startsWith("wss://")) {
    throw new Error(
      "No desktop identity yet. Run `pnpm desktop` once, or set PUBLIC_WS_URL=wss://api.alfrd.net/speech/<desktopClientId>/ws",
    );
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
  const elevenlabs = new ElevenLabsClient({ apiKey });
  const engine = await elevenlabs.speechEngine.create({
    name: "Alfred live2",
    speechEngine: { wsUrl },
    tts: {
      // eleven_flash_v2_5 crashes Speech Engine create with an ElevenLabs 500.
      // Flash v2 is the conversational model that accepts this voice id.
      modelId: "eleven_flash_v2",
      voiceId,
    },
    asr: {
      provider: "scribe_realtime",
      keywords: ["Alfred"],
    },
    turn: {
      turnEagerness: "patient",
      speculativeTurn: false,
    },
    privacy: {
      recordVoice: false,
    },
    conversation: {
      clientEvents: [
        "audio",
        "interruption",
        "user_transcript",
        "tentative_user_transcript",
        "agent_response",
        "agent_response_correction",
        "ping",
      ],
    },
  });

  console.log(`ELEVENLABS_SPEECH_ENGINE_ID=${engine.engineId}`);
  console.log(`voice=${voiceId} ws=${wsUrl}`);
  console.log("Add that id to .env, then run: make alfred VOICE=live2");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
