import { describe, expect, it } from "vitest";
import { createInMemoryPersistence } from "@alfred/persistence";
import {
  FakeLLMProvider,
  FakeMultiContextTTSProvider,
  FakeStreamingSTTProvider,
  ProviderRegistry,
} from "@alfred/providers";
import { FakeMemoryProvider, MemoryController } from "@alfred/memory";
import { AgentRouter, createCodexStub } from "@alfred/agents";
import type { UserConfiguration } from "@alfred/contracts";
import { FakeClock } from "./clock.js";
import { EventLedger } from "./event-ledger.js";
import { NoopObservability } from "./observability.js";
import { ResponseLedger } from "./response-ledger.js";
import { ConversationStateMachine } from "./state-machine.js";
import { VoiceSessionController } from "./voice-session.js";
import { NullMediaPort } from "./media-port.js";

function baseConfig(now: string): UserConfiguration {
  const settings = {
    connectionTimeoutMs: 1000,
    firstTokenTimeoutMs: 1000,
    totalRequestTimeoutMs: 5000,
    consecutiveFailureThreshold: 1,
    cooldownMs: 1000,
    retryPrimaryIntervalMs: 60_000,
    manualPin: false,
  };
  return {
    profile: {
      id: "p1",
      displayName: "T",
      activeMemoryProviderId: "memory.fake",
      createdAt: now,
      updatedAt: now,
    },
    providerConfigs: [],
    pipeline: {
      mode: "cascaded",
      allowCascadedFallback: false,
      sttPriority: {
        modality: "stt",
        orderedProviderIds: ["stt.fake.streaming"],
        settings,
      },
      llmPriority: {
        modality: "llm",
        orderedProviderIds: ["llm.fake"],
        settings,
      },
      ttsPriority: {
        modality: "tts",
        orderedProviderIds: ["tts.fake.multicontext"],
        settings,
      },
    },
    priorityLists: [],
    agentRouting: [],
    systemInstructions: "You are ALFRED.",
  };
}

describe("VoiceSessionController", () => {
  it("starts provisional generation on EagerEndOfTurn and commits on EndOfTurn", async () => {
    const clock = new FakeClock();
    const persistence = createInMemoryPersistence();
    const events = new EventLedger(persistence.events, clock, new NoopObservability());
    const sessionId = "sess_voice";
    const fsm = new ConversationStateMachine(sessionId, events);
    await fsm.transition("Listening", "start");
    const responseLedger = new ResponseLedger(persistence.responseLedgers, events, clock);

    const registry = new ProviderRegistry();
    const stt = new FakeStreamingSTTProvider();
    const llm = new FakeLLMProvider("llm.fake", { reply: "Provisional then final answer." });
    const tts = new FakeMultiContextTTSProvider();
    registry.registerStt(stt);
    registry.registerLlm(llm);
    registry.registerTts(tts);

    const memory = new MemoryController("p1", persistence.memorySettings);
    memory.register(new FakeMemoryProvider());
    await memory.initialize();

    const agents = new AgentRouter();
    agents.register(createCodexStub());

    const voice = new VoiceSessionController({
      sessionId,
      profileId: "p1",
      config: baseConfig(clock.nowIso()),
      clock,
      events,
      fsm,
      responseLedger,
      providers: registry,
      memory,
      agents,
      media: new NullMediaPort(),
      sttSessionFactory: async () => {
        const s = (await stt.openSession()) as import("@alfred/providers").FakeStreamingSTTSession;
        return s;
      },
      ttsSessionFactory: async () => tts.openMultiContextSession(),
    });

    await voice.start();
    const session = stt.lastSession.current!;

    session.pushEvent({ type: "start_of_turn", text: "Hello", metadata: {} });
    session.pushEvent({
      type: "eager_end_of_turn",
      text: "Hello Alfred",
      eagerEotConfidence: 0.7,
      metadata: {},
    });
    await new Promise((r) => setTimeout(r, 20));

    const evs = await events.list(sessionId);
    expect(evs.some((e) => e.type === "stt.eager_eot")).toBe(true);
    expect(evs.some((e) => e.type === "turn.provisional")).toBe(true);

    session.pushEvent({ type: "end_of_turn", text: "Hello Alfred", metadata: {} });
    await new Promise((r) => setTimeout(r, 80));

    const after = await events.list(sessionId);
    expect(after.some((e) => e.type === "stt.end_of_turn")).toBe(true);
    expect(after.some((e) => e.type === "turn.committed")).toBe(true);
    expect(
      after.some((e) => e.type === "tts.audio_buffered" || e.type === "response.delivered"),
    ).toBe(true);

    await voice.stop();
  });

  it("ignores mic STT that matches assistant speech (echo), but not a real barge-in", async () => {
    const clock = new FakeClock();
    const persistence = createInMemoryPersistence();
    const events = new EventLedger(persistence.events, clock, new NoopObservability());
    const sessionId = "sess_echo";
    const fsm = new ConversationStateMachine(sessionId, events);
    await fsm.force("Listening", "start");
    const responseLedger = new ResponseLedger(persistence.responseLedgers, events, clock);
    const registry = new ProviderRegistry();
    const stt = new FakeStreamingSTTProvider();
    registry.registerStt(stt);
    registry.registerLlm(new FakeLLMProvider("llm.fake", { reply: "I am Alfred the butler." }));
    registry.registerTts(new FakeMultiContextTTSProvider());
    const memory = new MemoryController("p1", persistence.memorySettings);
    memory.register(new FakeMemoryProvider());
    await memory.initialize();

    const voice = new VoiceSessionController({
      sessionId,
      profileId: "p1",
      config: baseConfig(clock.nowIso()),
      clock,
      events,
      fsm,
      responseLedger,
      providers: registry,
      memory,
      agents: new AgentRouter(),
      media: new NullMediaPort(),
      sttSessionFactory: async () => stt.openSession(),
      ttsSessionFactory: async () =>
        registry.getTts("tts.fake.multicontext").openMultiContextSession!(),
    });
    await voice.start();
    const session = stt.lastSession.current!;

    session.pushEvent({ type: "end_of_turn", text: "Who are you?", metadata: {} });
    await new Promise((r) => setTimeout(r, 40));

    // Echo of assistant speech — should be ignored.
    session.pushEvent({ type: "end_of_turn", text: "I am Alfred the butler.", metadata: {} });
    await new Promise((r) => setTimeout(r, 20));

    let commits = (await events.list(sessionId)).filter((e) => e.type === "turn.committed");
    expect(commits).toHaveLength(1);
    expect((commits[0]?.payload as { text?: string }).text).toBe("Who are you?");

    // Genuine barge-in text during echo window — should commit.
    session.pushEvent({
      type: "end_of_turn",
      text: "stop actually book a flight to Seattle tonight",
      metadata: {},
    });
    await new Promise((r) => setTimeout(r, 100));

    commits = (await events.list(sessionId)).filter((e) => e.type === "turn.committed");
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(
      commits.some(
        (c) =>
          (c.payload as { text?: string }).text ===
          "stop actually book a flight to Seattle tonight",
      ),
    ).toBe(true);

    await voice.stop();
  });

  it("abandons provisional work on TurnResumed", async () => {
    const clock = new FakeClock();
    const persistence = createInMemoryPersistence();
    const events = new EventLedger(persistence.events, clock, new NoopObservability());
    const sessionId = "sess_resume";
    const fsm = new ConversationStateMachine(sessionId, events);
    await fsm.force("Listening", "start");
    const responseLedger = new ResponseLedger(persistence.responseLedgers, events, clock);
    const registry = new ProviderRegistry();
    const stt = new FakeStreamingSTTProvider();
    registry.registerStt(stt);
    registry.registerLlm(
      new FakeLLMProvider(
        "llm.fake",
        {
          reply: "Long answer",
          firstTokenDelayMs: 1000,
        },
        clock,
      ),
    );
    registry.registerTts(new FakeMultiContextTTSProvider());
    const memory = new MemoryController("p1", persistence.memorySettings);
    memory.register(new FakeMemoryProvider());
    await memory.initialize();
    const agents = new AgentRouter();

    const voice = new VoiceSessionController({
      sessionId,
      profileId: "p1",
      config: baseConfig(clock.nowIso()),
      clock,
      events,
      fsm,
      responseLedger,
      providers: registry,
      memory,
      agents,
      sttSessionFactory: async () => stt.openSession(),
      ttsSessionFactory: async () =>
        registry.getTts("tts.fake.multicontext").openMultiContextSession!(),
    });
    await voice.start();
    const session = stt.lastSession.current!;
    session.pushEvent({
      type: "eager_end_of_turn",
      text: "Tell me about",
      metadata: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    session.pushEvent({
      type: "turn_resumed",
      text: "Tell me about Mars please",
      metadata: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    const evs = await events.list(sessionId);
    expect(evs.some((e) => e.type === "stt.turn_resumed")).toBe(true);
    expect(evs.some((e) => e.type === "response.abandoned" || e.type === "turn.addendum")).toBe(
      true,
    );
    await voice.stop();
  });
});
