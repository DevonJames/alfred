import {
  AgentRouter,
  createClaudeStub,
  createCodexStub,
  createHermesStub,
  createOpenClawStub,
} from "@alfred/agents";
import type { UserConfiguration } from "@alfred/contracts";
import {
  EventLedger,
  FakeClock,
  NoopObservability,
  ResponseLedger,
  ConversationStateMachine,
  SecretResolver,
  SystemClock,
  VoiceSessionController,
  type Clock,
} from "@alfred/core";
import { LiveKitMediaBridge } from "@alfred/livekit";
import {
  defaultMemoryPath,
  defaultOipMemoryRoot,
  ensureAndLoadPersona,
  LOCAL_MEMORY_PROVIDER_ID,
  LocalFileMemoryProvider,
  MemoryController,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  OipLocalMemoryProvider,
  type LoadedPersonaContext,
} from "@alfred/memory";
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
  config: UserConfiguration;
  clock: Clock;
  memory: MemoryController;
  memoryProviderId: string;
  memoryPath: string;
  persona: LoadedPersonaContext;
}

export async function createCascadedVoiceRuntime(opts?: {
  useFakeClock?: boolean;
}): Promise<VoiceRuntime> {
  const secrets = new SecretResolver();
  const deepgramKey = safeEnv(secrets, "DEEPGRAM_API_KEY");
  const openaiKey = safeEnv(secrets, "OPENAI_API_KEY");
  const elevenKey = safeEnv(secrets, "ELEVENLABS_API_KEY") || safeEnv(secrets, "ELEVEN_API_KEY");

  const clock: Clock = opts?.useFakeClock ? new FakeClock() : new SystemClock();
  const persistence = createInMemoryPersistence();
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

  const profileId = process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const memoryProviderId = process.env.ALFRED_MEMORY_PROVIDER_ID ?? LOCAL_MEMORY_PROVIDER_ID;
  const memoryPath = defaultMemoryPath(profileId);
  const oipMemoryRoot = defaultOipMemoryRoot(profileId);
  const localMemory = new LocalFileMemoryProvider(memoryPath, LOCAL_MEMORY_PROVIDER_ID);
  const oipMemory = new OipLocalMemoryProvider(oipMemoryRoot, OIP_LOCAL_MEMORY_PROVIDER_ID);

  const now = clock.nowIso();
  const config: UserConfiguration = {
    profile: {
      id: profileId,
      displayName: "ALFRED User",
      activeMemoryProviderId: memoryProviderId,
      createdAt: now,
      updatedAt: now,
    },
    providerConfigs: [],
    pipeline: {
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
    },
    priorityLists: [],
    agentRouting: [
      { category: "coding", orderedHarnessIds: ["harness.codex"] },
      { category: "email", orderedHarnessIds: ["harness.openclaw", "harness.hermes"] },
    ],
    systemInstructions:
      "You are ALFRED. Follow SOUL.md, IDENTITY.md, and USER.md below. Prefer delegate_task for external actions. Keep spoken answers concise.",
  };

  const memory = new MemoryController(config.profile.id, persistence.memorySettings);
  memory.register(localMemory);
  memory.register(oipMemory);
  await memory.initialize(memoryProviderId);

  const persona = await ensureAndLoadPersona(profileId);

  const agents = new AgentRouter();
  agents.register(createOpenClawStub());
  agents.register(createHermesStub());
  agents.register(createCodexStub());
  agents.register(createClaudeStub());
  agents.setRoutingRules(config.agentRouting);

  const sessionId = `sess_${Date.now().toString(36)}`;
  const events = new EventLedger(persistence.events, clock, new NoopObservability());
  const fsm = new ConversationStateMachine(sessionId, events);
  const responseLedger = new ResponseLedger(persistence.responseLedgers, events, clock);
  const media = new LiveKitMediaBridge();

  const voice = new VoiceSessionController({
    sessionId,
    profileId: config.profile.id,
    config,
    clock,
    events,
    fsm,
    responseLedger,
    providers: registry,
    memory,
    agents,
    media,
    personaContext: persona,
  });

  return {
    media,
    voice,
    registry,
    config,
    clock,
    memory,
    memoryProviderId: memory.getActiveProviderId() ?? memoryProviderId,
    memoryPath:
      (memory.getActiveProviderId() ?? memoryProviderId) === OIP_LOCAL_MEMORY_PROVIDER_ID
        ? oipMemory.path
        : localMemory.path,
    persona,
  };
}

function safeEnv(resolver: SecretResolver, name: string): string {
  try {
    return resolver.resolve({ kind: "env", name });
  } catch {
    return process.env[name] ?? "";
  }
}
