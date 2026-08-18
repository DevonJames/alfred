/**
 * Desktop-hosted text SessionOrchestrator for /api/conversation/*.
 * Uses OIP memory + OpenAI when configured; FakeLLM fallback otherwise.
 */

import {
  createClaudeStub,
  createCodexStub,
  createHermesStub,
  createOpenClawStub,
  createXIngestHarness,
  AgentRouter,
} from "@alfred/agents";
import { createPlaywrightCaptureAdapter } from "@alfred/browser";
import type { PipelineConfiguration, UserConfiguration } from "@alfred/contracts";
import { SessionOrchestrator, SystemClock } from "@alfred/core";
import { composeNotesCaptureAdapter, MemoryController, OIP_LOCAL_MEMORY_PROVIDER_ID } from "@alfred/memory";
import { createInMemoryPersistence } from "@alfred/persistence";
import {
  FakeLLMProvider,
  FakeSTTProvider,
  FakeTTSProvider,
  ProviderRegistry,
} from "@alfred/providers";
import {
  OPENAI_TERRA_PROVIDER_ID,
  OpenAiResponsesLLMProvider,
} from "@alfred/provider-openai";
import { activeProfileId, oipForProfile } from "./oip-memory.js";

type TextRuntime = {
  session: SessionOrchestrator;
  startedAt: string;
};

let runtime: TextRuntime | null = null;

function failoverSettings() {
  return {
    connectionTimeoutMs: 5_000,
    firstTokenTimeoutMs: 15_000,
    totalRequestTimeoutMs: 60_000,
    consecutiveFailureThreshold: 2,
    cooldownMs: 10_000,
    retryPrimaryIntervalMs: 60_000,
    manualPin: false,
  };
}

async function buildRuntime(): Promise<TextRuntime> {
  const clock = new SystemClock();
  const persistence = createInMemoryPersistence();
  const registry = new ProviderRegistry();
  const profileId = activeProfileId();
  const now = clock.nowIso();

  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const llmId = openaiKey ? OPENAI_TERRA_PROVIDER_ID : "llm.desktop.fake";

  if (openaiKey) {
    registry.registerLlm(new OpenAiResponsesLLMProvider({ apiKey: openaiKey }));
  } else {
    registry.registerLlm(
      new FakeLLMProvider(
        llmId,
        {
          reply: (user) =>
            `I heard: "${user}". (Desktop text path — set OPENAI_API_KEY for full replies.)`,
        },
        clock,
        "Desktop Fake LLM",
      ),
    );
  }

  registry.registerStt(new FakeSTTProvider("stt.desktop.fake", clock));
  registry.registerTts(new FakeTTSProvider("tts.desktop.fake", clock));

  const pipeline: PipelineConfiguration = {
    mode: "cascaded",
    allowCascadedFallback: false,
    sttPriority: {
      modality: "stt",
      orderedProviderIds: ["stt.desktop.fake"],
      settings: failoverSettings(),
    },
    llmPriority: {
      modality: "llm",
      orderedProviderIds: [llmId],
      settings: failoverSettings(),
    },
    ttsPriority: {
      modality: "tts",
      orderedProviderIds: ["tts.desktop.fake"],
      settings: failoverSettings(),
    },
  };

  const config: UserConfiguration = {
    profile: {
      id: profileId,
      displayName: process.env.DESKTOP_CLIENT_NAME ?? "Alfred",
      activeMemoryProviderId: OIP_LOCAL_MEMORY_PROVIDER_ID,
      createdAt: now,
      updatedAt: now,
    },
    providerConfigs: [],
    pipeline,
    priorityLists: [],
    agentRouting: [
      { category: "coding", orderedHarnessIds: ["harness.codex"] },
      { category: "email", orderedHarnessIds: ["harness.openclaw"] },
      { category: "computer_use", orderedHarnessIds: ["harness.x-ingest", "harness.openclaw"] },
      { category: "research", orderedHarnessIds: ["harness.x-ingest", "harness.hermes"] },
      { category: "browser", orderedHarnessIds: ["harness.x-ingest", "harness.hermes"] },
    ],
    systemInstructions:
      "You are ALFRED, a helpful personal assistant. Be concise. Use retrieved memory when relevant.",
  };

  const memory = new MemoryController(profileId, persistence.memorySettings);
  const oip = oipForProfile(profileId);
  memory.register(oip);
  await memory.initialize(OIP_LOCAL_MEMORY_PROVIDER_ID);

  const agents = new AgentRouter();
  agents.register(createOpenClawStub());
  agents.register(createHermesStub());
  agents.register(createCodexStub());
  agents.register(createClaudeStub());
  agents.register(
    createXIngestHarness({
      profileId,
      capture: composeNotesCaptureAdapter(createPlaywrightCaptureAdapter()),
    }),
  );
  agents.setRoutingRules(config.agentRouting);

  const session = new SessionOrchestrator({
    profileId,
    config,
    persistence,
    providers: registry,
    memory,
    agents,
    clock,
    speech: { chunkDurationMs: 0, charsPerChunk: 10_000 },
  });
  await session.start();

  return { session, startedAt: now };
}

export async function getTextSession(): Promise<SessionOrchestrator> {
  if (!runtime) {
    runtime = await buildRuntime();
  }
  return runtime.session;
}

/** Reset between tests. */
export function resetTextSessionForTests(): void {
  runtime = null;
}
