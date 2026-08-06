/**
 * ALFRED cascaded voice agent entrypoint.
 *
 * Pipeline: Deepgram Flux → OpenAI GPT-5.6 Terra → ElevenLabs Flash v2.5
 * Media: LiveKit room subscribe/publish via LiveKitRoomSession
 *        (conversation policy stays in @alfred/core)
 *
 * Usage:
 *   1. Fill .env (DEEPGRAM_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY,
 *      LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
 *   2. pnpm voice
 *   3. pnpm --filter @alfred/voice-agent token
 *   4. Join LIVEKIT_ROOM with LiveKit Meet / Agents Playground and enable mic
 *
 * Flow:
 *   remote mic → AudioStream PCM → LiveKitMediaBridge → VoiceSessionController
 *   assistant TTS PCM → AudioSource → published track → client speakers
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { LiveKitRoomSession } from "@alfred/livekit";
import { createCascadedVoiceRuntime } from "./wiring.js";

// Load repo-root .env when started from apps/voice-agent.
loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

async function main(): Promise<void> {
  const required = [
    "DEEPGRAM_API_KEY",
    "OPENAI_API_KEY",
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
  ];
  const eleven = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY;
  const missing = required.filter((k) => !process.env[k]);
  if (!eleven) missing.push("ELEVENLABS_API_KEY");

  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}. See .env.example.`);
    process.exitCode = 1;
    return;
  }

  const roomName = process.env.LIVEKIT_ROOM ?? "alfred-dev";
  const identity = process.env.LIVEKIT_IDENTITY ?? "alfred-agent";

  const runtime = await createCascadedVoiceRuntime();
  await runtime.voice.start();

  const roomSession = new LiveKitRoomSession({
    url: process.env.LIVEKIT_URL!,
    apiKey: process.env.LIVEKIT_API_KEY!,
    apiSecret: process.env.LIVEKIT_API_SECRET!,
    roomName,
    identity,
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
    media: runtime.media,
    targetIdentity: process.env.LIVEKIT_TARGET_IDENTITY,
  });

  await roomSession.start();

  console.log("ALFRED cascaded voice agent online");
  console.log(`  STT: ${runtime.config.pipeline.sttPriority?.orderedProviderIds[0]}`);
  console.log(`  LLM: ${runtime.config.pipeline.llmPriority?.orderedProviderIds[0]}`);
  console.log(`  TTS: ${runtime.config.pipeline.ttsPriority?.orderedProviderIds[0]}`);
  console.log(`  Memory: ${runtime.memoryProviderId} path=${runtime.memoryPath}`);
  console.log(
    `  Persona: ${runtime.persona.dir} (SOUL=${runtime.persona.soul ? "yes" : "no"} IDENTITY=${runtime.persona.identity ? "yes" : "no"} USER=${runtime.persona.user ? "yes" : "no"})`,
  );
  console.log(`  LiveKit: ${process.env.LIVEKIT_URL} room=${roomName} identity=${identity}`);
  console.log("  Join with mic enabled; agent publishes assistant audio track.");

  if (process.env.ALFRED_LOG_PLAYBACK === "1") {
    runtime.media.onPlayback((frame) => {
      console.log(`playback pcm bytes=${frame.data.byteLength} rate=${frame.sampleRate}`);
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`Shutting down (${signal})...`);
    await roomSession.stop();
    await runtime.voice.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
