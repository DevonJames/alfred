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
} from "@alfred/provider-deepgram";
import {
  APPLE_ONDEVICE_STT_PROVIDER_ID,
  AppleOnDeviceSTTProvider,
} from "@alfred/provider-apple-stt";
import {
  DEFAULT_ALFRED_VOICE_ID,
  ELEVENLABS_FLASH_PROVIDER_ID,
  ElevenLabsFlashTTSProvider,
  RECOMMENDED_TTS_PRIORITY,
} from "@alfred/provider-elevenlabs";
import {
  OPENAI_TERRA_PROVIDER_ID,
  OpenAiResponsesLLMProvider,
} from "@alfred/provider-openai";
import {
  resolveGrokApiKey,
  XAI_GROK_PROVIDER_ID,
  XaiGrokLLMProvider,
} from "@alfred/provider-xai";
import { ProviderRegistry } from "@alfred/providers";
import type { GreetingLlm } from "@alfred/briefing";
import { createAlfredBrain, safeEnv, type AlfredBrain } from "./brain.js";

const failoverSettings = {
  connectionTimeoutMs: 5_000,
  firstTokenTimeoutMs: 10_000,
  totalRequestTimeoutMs: 60_000,
  /** Fail over on first eligible failure so billing death does not burn a turn. */
  consecutiveFailureThreshold: 1,
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
  const sttOrderedIds: string[] = [];
  if (deepgramKey) {
    registry.registerStt(
      new DeepgramFluxSTTProvider({
        apiKey: deepgramKey,
        model: "flux-general-en",
        eagerEotThreshold: 0.4,
      }),
    );
    sttOrderedIds.push(DEEPGRAM_FLUX_PROVIDER_ID);
  } else {
    console.warn("[voice] DEEPGRAM_API_KEY unset — using Apple on-device STT if available");
  }
  if (process.platform === "darwin") {
    registry.registerStt(new AppleOnDeviceSTTProvider());
    sttOrderedIds.push(APPLE_ONDEVICE_STT_PROVIDER_ID);
  }
  if (sttOrderedIds.length === 0) {
    console.error(
      "[voice] No STT providers available (need DEEPGRAM_API_KEY or macOS Apple Speech)",
    );
  }
  registry.registerLlm(
    new OpenAiResponsesLLMProvider({
      apiKey: openaiKey,
    }),
  );
  const grokKey = resolveGrokApiKey();
  if (grokKey) {
    registry.registerLlm(
      new XaiGrokLLMProvider({
        apiKey: grokKey,
      }),
    );
  } else {
    console.warn(
      "[voice] GROK_API_KEY / XAI_API_KEY unset — OpenAI LLM has no Grok failover",
    );
  }
  registry.registerTts(
    new ElevenLabsFlashTTSProvider({
      apiKey: elevenKey,
      voiceId: process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_ALFRED_VOICE_ID,
      modelId: "eleven_flash_v2_5",
      sampleRate: 24_000,
    }),
  );

  const llmOrderedIds = [
    OPENAI_TERRA_PROVIDER_ID,
    ...(grokKey ? [XAI_GROK_PROVIDER_ID] : []),
  ];

  const greetingLlm: GreetingLlm = async (messages) => {
    for (const llmId of llmOrderedIds) {
      try {
        const llm = registry.getLlm(llmId);
        let text = "";
        let failed = false;
        for await (const chunk of llm.generateStream({
          messages,
          modelPreset: "conversational",
          reasoningEffort: "none",
        })) {
          if (chunk.type === "error") {
            failed = true;
            break;
          }
          if (chunk.type === "token" && chunk.text) text += chunk.text;
        }
        if (!failed && text) return text;
      } catch {
        /* try next */
      }
    }
    return "";
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
      orderedProviderIds: sttOrderedIds.length
        ? sttOrderedIds
        : [DEEPGRAM_FLUX_PROVIDER_ID],
      settings: { ...failoverSettings },
    },
    llmPriority: {
      modality: "llm",
      orderedProviderIds: llmOrderedIds,
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
    news: brain.news,
    markets: brain.markets,
    currentTime: brain.currentTime,
    situational: brain.situational,
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
