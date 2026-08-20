/**
 * Multi-session text SessionOrchestrator for /api/conversation/*.
 * Sidecar mode keys sessions by householdId + targetAgentId and uses OIP memory.
 */

import {
  AgentRouter,
  createAlfredHomeHarness,
  createClaudeStub,
  createCodexStub,
  createHermesStub,
  createOpenClawHarness,
  createXIngestHarness,
} from "@alfred/agents";
import { createPlaywrightCaptureAdapter } from "@alfred/browser";
import type { PipelineConfiguration, UserConfiguration } from "@alfred/contracts";
import { SessionOrchestrator, SystemClock } from "@alfred/core";
import {
  composeNotesCaptureAdapter,
  ensurePersonaFiles,
  loadPersonaContext,
  MemoryController,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
} from "@alfred/memory";
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
import { oipForProfile, personaDirForProfile } from "./oip-memory.js";

export type SessionKeyParts = {
  householdId?: string;
  targetAgentId?: string;
  sessionKey?: string;
};

type TextRuntime = {
  session: SessionOrchestrator;
  startedAt: string;
  homeContext: { householdId?: string; deviceToken?: string };
};

const runtimes = new Map<string, TextRuntime>();

export function conversationSessionKey(parts: SessionKeyParts): string {
  if (parts.sessionKey?.trim()) return parts.sessionKey.trim();
  const household = parts.householdId?.trim() || process.env.ALFRED_PROFILE_ID || "profile.default";
  const agent = parts.targetAgentId?.trim() || "default";
  return `${household}:${agent}`;
}

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

async function buildRuntime(sessionKey: string, parts: SessionKeyParts): Promise<TextRuntime> {
  const clock = new SystemClock();
  const persistence = createInMemoryPersistence();
  const registry = new ProviderRegistry();
  const profileId = parts.householdId?.trim() || process.env.ALFRED_PROFILE_ID || "profile.default";
  const now = clock.nowIso();
  const homeContext: { householdId?: string; deviceToken?: string } = {
    householdId: parts.householdId?.trim() || profileId,
  };

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
      { category: "household", orderedHarnessIds: ["harness.alfred-home"] },
      { category: "calendar", orderedHarnessIds: ["harness.alfred-home"] },
      { category: "coding", orderedHarnessIds: ["harness.openclaw"] },
      { category: "email", orderedHarnessIds: ["harness.openclaw"] },
      { category: "computer_use", orderedHarnessIds: ["harness.alfred-home", "harness.x-ingest"] },
      { category: "research", orderedHarnessIds: ["harness.x-ingest", "harness.openclaw"] },
      { category: "browser", orderedHarnessIds: ["harness.x-ingest", "harness.openclaw"] },
      { category: "general", orderedHarnessIds: ["harness.alfred-home", "harness.openclaw"] },
    ],
    systemInstructions:
      "You are ALFRED, a helpful personal assistant. Be concise. Use retrieved memory when relevant. For household calendar, camera, reminders, or approvals, use delegate_task with category household.",
  };

  const memory = new MemoryController(profileId, persistence.memorySettings);
  const oip = oipForProfile(profileId);
  memory.register(oip);
  await memory.initialize(OIP_LOCAL_MEMORY_PROVIDER_ID);

  const personaDir = personaDirForProfile(profileId);
  await ensurePersonaFiles(personaDir);
  const personaContext = await loadPersonaContext(personaDir);

  const agents = new AgentRouter();
  agents.register(createAlfredHomeHarness({ getContext: () => homeContext }));
  agents.register(createOpenClawHarness());
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
    sessionId: `sess_${sessionKey.replace(/[^a-zA-Z0-9:_-]/g, "_")}`,
    profileId,
    config,
    persistence,
    providers: registry,
    memory,
    agents,
    clock,
    personaContext,
    speech: { chunkDurationMs: 0, charsPerChunk: 10_000 },
  });
  await session.start();

  return { session, startedAt: now, homeContext };
}

export async function getTextSession(
  parts: SessionKeyParts = {},
): Promise<SessionOrchestrator> {
  const key = conversationSessionKey(parts);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = await buildRuntime(key, parts);
    runtimes.set(key, runtime);
  }
  if (parts.householdId) runtime.homeContext.householdId = parts.householdId;
  return runtime.session;
}

export function setHomeDeviceToken(parts: SessionKeyParts, deviceToken?: string): void {
  const key = conversationSessionKey(parts);
  const runtime = runtimes.get(key);
  if (runtime) runtime.homeContext.deviceToken = deviceToken;
}

export async function cancelTextSession(parts: SessionKeyParts): Promise<boolean> {
  const key = conversationSessionKey(parts);
  const runtime = runtimes.get(key);
  if (!runtime) return false;
  await runtime.session.cancel("user_cancellation");
  return true;
}

export async function resetTextSession(parts: SessionKeyParts): Promise<void> {
  const key = conversationSessionKey(parts);
  const runtime = runtimes.get(key);
  if (runtime) {
    try {
      await runtime.session.cancel("user_cancellation");
    } catch {
      // ignore
    }
    runtimes.delete(key);
  }
}

/** Reset between tests. */
export function resetTextSessionForTests(): void {
  runtimes.clear();
}

/** Used by GET /health */
export function sidecarRuntimeReady(): { sessions: number; openai: boolean } {
  return {
    sessions: runtimes.size,
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  };
}

/** Warm default OIP provider so /health can report memory ready. */
export async function warmupSidecarMemory(): Promise<{ ok: boolean; path: string }> {
  const profileId = process.env.ALFRED_PROFILE_ID || "profile.default";
  const oip = oipForProfile(profileId);
  await oip.inspect(1);
  return { ok: true, path: oip.path };
}
