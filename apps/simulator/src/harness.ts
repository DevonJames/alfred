import {
  createClaudeStub,
  createCodexStub,
  createHermesStub,
  createOpenClawStub,
  AgentRouter,
  type StubAgentHarness,
} from "@alfred/agents";
import type { PipelineConfiguration, UserConfiguration } from "@alfred/contracts";
import { FakeClock, SessionOrchestrator } from "@alfred/core";
import { FakeMemoryProvider, LocalFileMemoryProvider, MemoryController } from "@alfred/memory";
import { createInMemoryPersistence } from "@alfred/persistence";
import {
  FakeLLMProvider,
  FakeSTTProvider,
  FakeTTSProvider,
  FakeUnifiedProvider,
  ProviderRegistry,
} from "@alfred/providers";

export interface SimulatorWorld {
  clock: FakeClock;
  session: SessionOrchestrator;
  registry: ProviderRegistry;
  memory: MemoryController;
  agents: AgentRouter;
  llmPrimary: FakeLLMProvider;
  llmSecondary: FakeLLMProvider;
  openclaw: StubAgentHarness;
  hermes: StubAgentHarness;
  codex: StubAgentHarness;
  claude: StubAgentHarness;
  persistence: ReturnType<typeof createInMemoryPersistence>;
  config: UserConfiguration;
}

export interface WorldOptions {
  pipeline?: PipelineConfiguration;
  llmPrimaryFailTimes?: number;
  openclawFailTimes?: number;
  memorySeed?: Array<{ content: string; id?: string }>;
  systemInstructions?: string;
}

export async function createWorld(options: WorldOptions = {}): Promise<SimulatorWorld> {
  const clock = new FakeClock();
  const persistence = createInMemoryPersistence();
  const registry = new ProviderRegistry();

  const llmPrimary = new FakeLLMProvider(
    "llm.primary",
    {
      failTimes: options.llmPrimaryFailTimes ?? 0,
      failureClass: "upstream_5xx",
      reply: (user) =>
        `Primary answer to "${user}". This is a longer explanation that continues across multiple sentences so interruption tests can slice delivery.`,
    },
    clock,
    "Primary LLM",
  );
  const llmSecondary = new FakeLLMProvider(
    "llm.secondary",
    {
      reply: (user) => `Secondary answer to "${user}".`,
    },
    clock,
    "Secondary LLM",
  );
  const stt = new FakeSTTProvider("stt.fake", clock);
  const tts = new FakeTTSProvider("tts.fake", clock);
  const unifiedA = new FakeUnifiedProvider("unified.alpha", "stack-alpha", clock, "Unified Alpha");
  const unifiedB = new FakeUnifiedProvider("unified.beta", "stack-beta", clock, "Unified Beta");

  registry.registerLlm(llmPrimary);
  registry.registerLlm(llmSecondary);
  registry.registerStt(stt);
  registry.registerTts(tts);
  registry.registerUnified(unifiedA);
  registry.registerUnified(unifiedB);

  const now = clock.nowIso();
  const pipeline: PipelineConfiguration =
    options.pipeline ??
    ({
      mode: "cascaded",
      allowCascadedFallback: false,
      sttPriority: {
        modality: "stt",
        orderedProviderIds: ["stt.fake"],
        settings: {
          connectionTimeoutMs: 1000,
          firstTokenTimeoutMs: 1000,
          totalRequestTimeoutMs: 5000,
          consecutiveFailureThreshold: 1,
          cooldownMs: 10_000,
          retryPrimaryIntervalMs: 60_000,
          manualPin: false,
        },
      },
      llmPriority: {
        modality: "llm",
        orderedProviderIds: ["llm.primary", "llm.secondary"],
        settings: {
          connectionTimeoutMs: 1000,
          firstTokenTimeoutMs: 1000,
          totalRequestTimeoutMs: 5000,
          consecutiveFailureThreshold: 1,
          cooldownMs: 10_000,
          retryPrimaryIntervalMs: 60_000,
          manualPin: false,
        },
      },
      ttsPriority: {
        modality: "tts",
        orderedProviderIds: ["tts.fake"],
        settings: {
          connectionTimeoutMs: 1000,
          firstTokenTimeoutMs: 1000,
          totalRequestTimeoutMs: 5000,
          consecutiveFailureThreshold: 1,
          cooldownMs: 10_000,
          retryPrimaryIntervalMs: 60_000,
          manualPin: false,
        },
      },
    } satisfies PipelineConfiguration);

  const config: UserConfiguration = {
    profile: {
      id: "profile.demo",
      displayName: "Demo User",
      activeMemoryProviderId: "memory.fake",
      createdAt: now,
      updatedAt: now,
    },
    providerConfigs: [],
    pipeline,
    priorityLists: [],
    agentRouting: [
      {
        category: "coding",
        orderedHarnessIds: ["harness.codex", "harness.claude"],
      },
      {
        category: "email",
        orderedHarnessIds: ["harness.openclaw", "harness.hermes"],
      },
      {
        category: "computer_use",
        orderedHarnessIds: ["harness.openclaw", "harness.hermes", "harness.claude"],
      },
      {
        category: "research",
        orderedHarnessIds: ["harness.hermes", "harness.claude"],
      },
    ],
    systemInstructions:
      options.systemInstructions ??
      "You are ALFRED. Be concise. Prefer delegate_task for external actions.",
  };

  const memory = new MemoryController("profile.demo", persistence.memorySettings);
  memory.register(
    new FakeMemoryProvider(
      "memory.fake",
      options.memorySeed ?? [
        { id: "pref-1", content: "User prefers concise answers and dark mode." },
      ],
    ),
  );
  memory.register(new FakeMemoryProvider("memory.fake.alt", []));
  // Local provider registered for scenario 15 / capability demo; active remains fake unless switched.
  memory.register(new LocalFileMemoryProvider("/tmp/alfred-m1-memory.jsonl", "memory.local"));
  await memory.initialize("memory.fake");

  const openclaw = createOpenClawStub(options.openclawFailTimes ?? 0);
  const hermes = createHermesStub();
  const codex = createCodexStub();
  const claude = createClaudeStub();
  const agents = new AgentRouter();
  agents.register(openclaw);
  agents.register(hermes);
  agents.register(codex);
  agents.register(claude);
  agents.setRoutingRules(config.agentRouting);

  const session = new SessionOrchestrator({
    profileId: "profile.demo",
    config,
    persistence,
    providers: registry,
    memory,
    agents,
    clock,
    speech: { chunkDurationMs: 10, charsPerChunk: 16 },
  });
  await session.start();

  return {
    clock,
    session,
    registry,
    memory,
    agents,
    llmPrimary,
    llmSecondary,
    openclaw,
    hermes,
    codex,
    claude,
    persistence,
    config,
  };
}
