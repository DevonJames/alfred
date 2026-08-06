export {
  DEFAULT_ALFRED_VOICE_ID,
  ELEVENLABS_FLASH_PROVIDER_ID,
  ElevenLabsFlashTTSProvider,
  mapElevenLabsMessage,
  type ElevenLabsFlashOptions,
} from "./flash-tts.js";

/** Documented TTS priority (Cartesia / Deepgram Flux TTS / local are stubs). */
export const RECOMMENDED_TTS_PRIORITY = [
  "tts.elevenlabs.flash_v2_5",
  "tts.cartesia.sonic_3_5", // stub
  "tts.deepgram.flux_tts", // stub — early access
  "tts.local", // stub
] as const;
