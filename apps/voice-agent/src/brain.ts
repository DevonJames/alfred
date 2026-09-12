/**
 * Shared Alfred services for both cascade voice and GPT-Live.
 * Memory, persona, briefing, reminders, weather, lights, agent harnesses.
 */
import {
  AgentRouter,
  createClaudeStub,
  createCodexStub,
  createDocsIngestHarness,
  createHermesStub,
  createOpenClawStub,
  createXIngestHarness,
} from "@alfred/agents";
import {
  createBriefingController,
  lookupLiveWeatherForecast,
  type BriefingController,
  type GreetingLlm,
} from "@alfred/briefing";
import { createPlaywrightCaptureAdapter } from "@alfred/browser";
import type { UserConfiguration } from "@alfred/contracts";
import {
  FakeClock,
  SecretResolver,
  SystemClock,
  type Clock,
  type DueReminderSummary,
  type ReminderPort,
} from "@alfred/core";
import { createElgatoLightsController, type ElgatoLightsController } from "@alfred/elgato";
import {
  defaultMemoryPath,
  defaultOipMemoryRoot,
  ensureAndLoadPersona,
  LOCAL_MEMORY_PROVIDER_ID,
  LocalFileMemoryProvider,
  MemoryController,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  OipLocalMemoryProvider,
  composeNotesCaptureAdapter,
  type LoadedPersonaContext,
} from "@alfred/memory";
import { createInMemoryPersistence } from "@alfred/persistence";
import { createOipReminderPort } from "./reminder-port.js";

export interface AlfredBrain {
  clock: Clock;
  profileId: string;
  sessionId: string;
  config: UserConfiguration;
  memory: MemoryController;
  memoryProviderId: string;
  memoryPath: string;
  oipMemory: OipLocalMemoryProvider;
  persona: LoadedPersonaContext;
  agents: AgentRouter;
  briefing: BriefingController;
  reminders: ReminderPort;
  structuredMemory: {
    remember(write: {
      entities?: Array<{
        name: string;
        entityClass?: string;
        summary?: string;
        email?: string;
        telephone?: string;
        birthDate?: string;
      }>;
      assertions?: Array<{
        subjectName: string;
        predicate: string;
        objectName: string;
        text?: string;
      }>;
      notes?: string[];
    }): Promise<{
      entitiesUpserted: number;
      assertionsCreated: number;
      notesCreated: number;
    }>;
  };
  weather: {
    getForecast(opts?: { location?: string; days?: number }): Promise<string>;
  };
  lights: ElgatoLightsController;
  listDueReminders(): Promise<DueReminderSummary[]>;
}

export async function createAlfredBrain(opts?: {
  useFakeClock?: boolean;
  greetingLlm?: GreetingLlm;
}): Promise<AlfredBrain> {
  const clock: Clock = opts?.useFakeClock ? new FakeClock() : new SystemClock();
  const persistence = createInMemoryPersistence();

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
    },
    priorityLists: [],
    agentRouting: [
      { category: "coding", orderedHarnessIds: ["harness.codex"] },
      { category: "email", orderedHarnessIds: ["harness.openclaw", "harness.hermes"] },
      {
        category: "research",
        orderedHarnessIds: ["harness.docs-ingest", "harness.x-ingest", "harness.hermes"],
      },
      { category: "browser", orderedHarnessIds: ["harness.x-ingest", "harness.hermes"] },
      { category: "computer_use", orderedHarnessIds: ["harness.x-ingest", "harness.claude"] },
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
  agents.register(createDocsIngestHarness({ profileId }));
  agents.register(
    createXIngestHarness({
      profileId,
      capture: composeNotesCaptureAdapter(createPlaywrightCaptureAdapter()),
    }),
  );
  agents.setRoutingRules(config.agentRouting);

  const briefing = createBriefingController({
    memory: oipMemory,
    llm: opts?.greetingLlm,
  });
  const reminders = createOipReminderPort(oipMemory, briefing);
  const structuredMemory = {
    async remember(write: {
      entities?: Array<{
        name: string;
        entityClass?: string;
        summary?: string;
        email?: string;
        telephone?: string;
        birthDate?: string;
      }>;
      assertions?: Array<{
        subjectName: string;
        predicate: string;
        objectName: string;
        text?: string;
      }>;
      notes?: string[];
    }) {
      const { writeConversationalMemory } = await import("@alfred/memory");
      return writeConversationalMemory(oipMemory, write);
    },
  };
  const weather = {
    async getForecast(opts?: { location?: string; days?: number }) {
      return lookupLiveWeatherForecast({
        location: opts?.location,
        days: opts?.days,
      });
    },
  };
  const lights = createElgatoLightsController();
  void lights.refresh().catch((err) => {
    console.warn("[brain] Elgato light discovery failed:", err);
  });

  const sessionId = `sess_${Date.now().toString(36)}`;

  return {
    clock,
    profileId,
    sessionId,
    config,
    memory,
    memoryProviderId: memory.getActiveProviderId() ?? memoryProviderId,
    memoryPath:
      (memory.getActiveProviderId() ?? memoryProviderId) === OIP_LOCAL_MEMORY_PROVIDER_ID
        ? oipMemory.path
        : localMemory.path,
    oipMemory,
    persona,
    agents,
    briefing,
    reminders,
    structuredMemory,
    weather,
    lights,
    async listDueReminders() {
      try {
        return await reminders.listDue();
      } catch (err) {
        console.warn("[brain] listDue reminders failed:", err);
        return [];
      }
    },
  };
}

/** Resolve env secret or empty string (cascade wiring helper). */
export function safeEnv(resolver: SecretResolver, name: string): string {
  try {
    return resolver.resolve({ kind: "env", name });
  } catch {
    return process.env[name] ?? "";
  }
}
