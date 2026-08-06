export {
  DEEPGRAM_FLUX_PROVIDER_ID,
  DeepgramFluxSTTProvider,
  mapFluxMessage,
  type DeepgramFluxOptions,
} from "./flux-stt.js";

/** Documented STT priority for cascaded profiles (adapters beyond Flux are stubs). */
export const RECOMMENDED_STT_PRIORITY = [
  "stt.deepgram.flux",
  "stt.elevenlabs.scribe", // stub — multilingual fallback
  "stt.openai.realtime_whisper", // stub
  "stt.local.whisper_large_v3_turbo", // stub
] as const;
