import {
  EventLedger,
  NoopObservability,
  ResponseLedger,
  ConversationStateMachine,
  SecretResolver,
  VoiceSessionController,
  type Clock,
} from "@alfred/core";
import { LiveKitMediaBridge } from "@alfred/livekit";
import { createInMemoryPersistence } from "@alfred/persistence";
import {
  DEEPGRAM_FLUX_PROVIDER_ID,
  DeepgramFluxSTTProvider,
  RECOMMENDED_STT_PRIORITY,
} from "@alfred/provider-deepgram";
import {
  DEFAULT_ALFRED_VOICE_ID,
  ELEVENLABS_FLASH_PROVIDER_ID,
  ElevenLabsFlashTTSProvider,
  RECOMMENDED_TTS_PRIORITY,
} from "@alfred/provider-elevenlabs";
import {
  OPENAI_TERRA_PROVIDER_ID,
  OpenAiResponsesLLMProvider,
  RECOMMENDED_LLM_PRIORITY,
} from "@alfred/provider-openai";
import { ProviderRegistry } from "@alfred/providers";
import type { GreetingLlm } from "@alfred/briefing";
import { createAlfredBrain, safeEnv, type AlfredBrain } from "./brain.js";

const failoverSettings = {
  connectionTimeoutMs: 5_000,
  firstTokenTimeoutMs: 10_000,
  totalRequestTimeoutMs: 60_000,
  consecutiveFailureThreshold: 2,
  cooldownMs: 30_000,
  retryPrimaryIntervalMs: 300_000,
  manualPin: false,
};

export interface VoiceRuntime {
  media: LiveKitMediaBridge;
  voice: VoiceSessionController;
  registry: ProviderRegistry;
  config: AlfredBrain["config"];
  clock: Clock;
  memory: AlfredBrain["memory"];
  memoryProviderId: string;
  memoryPath: string;
  persona: AlfredBrain["persona"];
}

export async function createCascadedVoiceRuntime(opts?: {
  useFakeClock?: boolean;
}): Promise<VoiceRuntime> {
  const secrets = new SecretResolver();
  const deepgramKey = safeEnv(secrets, "DEEPGRAM_API_KEY");
  const openaiKey = safeEnv(secrets, "OPENAI_API_KEY");
  const elevenKey = safeEnv(secrets, "ELEVENLABS_API_KEY") || safeEnv(secrets, "ELEVEN_API_KEY");

  const registry = new ProviderRegistry();
  registry.registerStt(
    new DeepgramFluxSTTProvider({
      apiKey: deepgramKey,
      model: "flux-general-en",
      eagerEotThreshold: 0.4,
    }),
  );
  registry.registerLlm(
    new OpenAiResponsesLLMProvider({
      apiKey: openaiKey,
    }),
  );
  registry.registerTts(
    new ElevenLabsFlashTTSProvider({
      apiKey: elevenKey,
      voiceId: process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_ALFRED_VOICE_ID,
      modelId: "eleven_flash_v2_5",
      sampleRate: 24_000,
    }),
  );

  const greetingLlm: GreetingLlm = async (messages) => {
    const llm = registry.getLlm(OPENAI_TERRA_PROVIDER_ID);
    let text = "";
    for await (const chunk of llm.generateStream({
      messages,
      modelPreset: "conversational",
      reasoningEffort: "none",
    })) {
      if (chunk.type === "token" && chunk.text) text += chunk.text;
    }
    return text;
  };

  const brain = await createAlfredBrain({
    useFakeClock: opts?.useFakeClock,
    greetingLlm,
  });

  brain.config.pipeline = {
    mode: "cascaded",
    allowCascadedFallback: false,
    sttPriority: {
      modality: "stt",
      orderedProviderIds: [DEEPGRAM_FLUX_PROVIDER_ID, ...RECOMMENDED_STT_PRIORITY.slice(1)],
      settings: { ...failoverSettings },
    },
    llmPriority: {
      modality: "llm",
      orderedProviderIds: [OPENAI_TERRA_PROVIDER_ID, ...RECOMMENDED_LLM_PRIORITY.slice(1)],
      settings: { ...failoverSettings },
    },
    ttsPriority: {
      modality: "tts",
      orderedProviderIds: [ELEVENLABS_FLASH_PROVIDER_ID, ...RECOMMENDED_TTS_PRIORITY.slice(1)],
      settings: { ...failoverSettings },
    },
  };

  const persistence = createInMemoryPersistence();
  const events = new EventLedger(persistence.events, brain.clock, new NoopObservability());
  const fsm = new ConversationStateMachine(brain.sessionId, events);
  const responseLedger = new ResponseLedger(persistence.responseLedgers, events, brain.clock);
  const media = new LiveKitMediaBridge();

  const voice = new VoiceSessionController({
    sessionId: brain.sessionId,
    profileId: brain.profileId,
    config: brain.config,
    clock: brain.clock,
    events,
    fsm,
    responseLedger,
    providers: registry,
    memory: brain.memory,
    agents: brain.agents,
    media,
    personaContext: brain.persona,
    briefing: brain.briefing,
    reminders: brain.reminders,
    structuredMemory: brain.structuredMemory,
    weather: brain.weather,
    lights: brain.lights,
  });

  return {
    media,
    voice,
    registry,
    config: brain.config,
    clock: brain.clock,
    memory: brain.memory,
    memoryProviderId: brain.memoryProviderId,
    memoryPath: brain.memoryPath,
    persona: brain.persona,
  };
}
