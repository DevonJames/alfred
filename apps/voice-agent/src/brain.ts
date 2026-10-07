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
  calendarPolicyPath,
  createCalendarGatewayHarness,
  createOpenClawStub,
  loadBriefingAgendaEvents,
  createXIngestHarness,
} from "@alfred/agents";
import {
  createBriefingController,
  loadBriefingPrefs,
  lookupCurrentTime,
  lookupEarthquakes,
  lookupExchangeRate,
  lookupHackerNews,
  lookupLiveCryptoPrice,
  lookupLiveMetalsPrice,
  lookupLiveNewsHeadlines,
  lookupLiveWeatherForecast,
  lookupNaturalEvents,
  lookupSpaceWeather,
  lookupWeatherAlerts,
  summarizeNewsArticle,
  type BriefingController,
  type GreetingLlm,
  type NewsHeadline,
} from "@alfred/briefing";
import { createPlaywrightCaptureAdapter } from "@alfred/browser";
import type { UserConfiguration } from "@alfred/contracts";
import {
  createHttpArchivePort,
  FakeClock,
  SecretResolver,
  SystemClock,
  type ArchivePort,
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

const HYPATIA_INSTRUCTIONS =
  "You are HYPATIA, the librarian of a local Alexandria archive. Follow the persona below. " +
  "For documents, people, places, events, and collections, call search_archive or ask_archive. " +
  "Name the records you use. Source documents and AI analyses are different kinds of records. " +
  "Never state a truth score or percentage. Keep spoken answers to a few sentences.";

const HYPATIA_SOUL =
  "You sit beside the reader. You are concise, precise, and unwilling to flatten evidence into a score. " +
  "If the archive does not contain something, say so. Possible name matches stay possible; do not merge them.";

const HYPATIA_IDENTITY =
  "HYPATIA — HYPermedia Agent for Transparent Information Access. " +
  "You speak for the local Open Index, not for Alfred's personal assistant duties, while this archive is connected.";

async function agendaBriefingEvents(now: Date) {
  const prefs = await loadBriefingPrefs();
  if (!prefs.agendaCalendarIds.length) return { enabled: false, events: [] };
  try {
    const events = await loadBriefingAgendaEvents({
      policyPath: calendarPolicyPath(),
      calendarIds: prefs.agendaCalendarIds,
      now,
      timeZone: process.env.BRIEFING_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return { enabled: true, events };
  } catch (err) {
    console.warn("[voice] agenda briefing", err instanceof Error ? err.message : err);
    return { enabled: false, events: [] };
  }
}

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
  news: {
    getHeadlines(): Promise<{ speech: string; headlines: NewsHeadline[] }>;
    rememberHeadlines(headlines: NewsHeadline[]): void;
    summarizeArticle(opts: {
      index?: number;
      match?: string;
      url?: string;
      title?: string;
      recent?: NewsHeadline[];
    }): Promise<string>;
  };
  markets: {
    getCryptoPrice(opts?: { cryptoId?: string }): Promise<string>;
    getMetalsPrice(opts?: { metalSymbol?: "gold" | "silver" }): Promise<string>;
  };
  currentTime: {
    getCurrentTime(opts?: { place?: string; kind?: "time" | "date" }): Promise<string>;
  };
  situational: {
    earthquakes(query?: {
      scope?: "significant" | "notable";
      recent?: boolean;
      place?: string;
    }): Promise<string>;
    weatherAlerts(query?: { location?: string }): Promise<string>;
    spaceWeather(): Promise<string>;
    naturalEvents(query?: { kind?: "wildfires" | "volcanoes" | "both" }): Promise<string>;
    exchangeRate(query: {
      amount?: number;
      from: string;
      to: string;
      change?: boolean;
    }): Promise<string>;
    hackerNews(query?: { topic?: "general" | "ai" }): Promise<string>;
  };
  lights: ElgatoLightsController;
  archive?: ArchivePort;
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
      { category: "calendar", orderedHarnessIds: ["harness.openclaw-local"] },
    ],
    systemInstructions:
      "You are ALFRED. Follow SOUL.md, IDENTITY.md, and USER.md below. Prefer delegate_task for external actions. For calendars on this Mac, use delegate_task with category calendar and the user's own wording, including the clock time and calendar name. If they answer a calendar question, call delegate_task again instead of repeating it. Keep spoken answers concise.",
  };

  const memory = new MemoryController(config.profile.id, persistence.memorySettings);
  memory.register(localMemory);
  memory.register(oipMemory);
  await memory.initialize(memoryProviderId);

  const personaLoaded = await ensureAndLoadPersona(profileId);
  const archiveUrl = process.env.ALFRED_ARCHIVE_URL?.trim();
  const archive = archiveUrl ? createHttpArchivePort(archiveUrl) : undefined;
  const persona = archive
    ? {
        dir: personaLoaded.dir,
        soul: HYPATIA_SOUL,
        identity: HYPATIA_IDENTITY,
        user: "The user is researching documents in a local Alexandria archive.",
      }
    : personaLoaded;
  if (archive) {
    config.systemInstructions = HYPATIA_INSTRUCTIONS;
  }

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
  agents.register(createCalendarGatewayHarness({ profileId }));
  agents.setRoutingRules(config.agentRouting);

  const briefing = createBriefingController({
    memory: oipMemory,
    llm: opts?.greetingLlm,
    agendaEvents: agendaBriefingEvents,
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
  let recentNews: NewsHeadline[] = [];
  const news = {
    async getHeadlines() {
      const result = await lookupLiveNewsHeadlines();
      recentNews = result.headlines;
      return result;
    },
    rememberHeadlines(headlines: NewsHeadline[]) {
      recentNews = headlines;
    },
    async summarizeArticle(articleOpts: {
      index?: number;
      match?: string;
      url?: string;
      title?: string;
      recent?: NewsHeadline[];
    }) {
      return summarizeNewsArticle({
        ...articleOpts,
        recent: articleOpts.recent?.length ? articleOpts.recent : recentNews,
        llm: opts?.greetingLlm,
      });
    },
  };
  const markets = {
    getCryptoPrice: (marketOpts?: { cryptoId?: string }) =>
      lookupLiveCryptoPrice({ cryptoId: marketOpts?.cryptoId }),
    getMetalsPrice: (marketOpts?: { metalSymbol?: "gold" | "silver" }) =>
      lookupLiveMetalsPrice({ metalSymbol: marketOpts?.metalSymbol }),
  };
  const currentTime = {
    getCurrentTime: (opts?: { place?: string; kind?: "time" | "date" }) =>
      lookupCurrentTime({ place: opts?.place, kind: opts?.kind }),
  };
  const situational = {
    earthquakes: lookupEarthquakes,
    weatherAlerts: lookupWeatherAlerts,
    spaceWeather: lookupSpaceWeather,
    naturalEvents: lookupNaturalEvents,
    exchangeRate: lookupExchangeRate,
    hackerNews: lookupHackerNews,
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
    news,
    markets,
    currentTime,
    situational,
    lights,
    archive,
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
