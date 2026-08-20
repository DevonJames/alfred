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
import {
  NullMediaPort,
  parseUiCommand,
  type AssistantCaptionEvent,
  type UserTranscriptEvent,
} from "./media-port.js";

class RecordingMediaPort extends NullMediaPort {
  captions: AssistantCaptionEvent[] = [];
  userTranscripts: UserTranscriptEvent[] = [];
  pcmFrames = 0;

  async playPcm(): Promise<void> {
    this.pcmFrames += 1;
  }

  async publishCaption(event: AssistantCaptionEvent): Promise<void> {
    this.captions.push(event);
  }

  async publishUserTranscript(event: UserTranscriptEvent): Promise<void> {
    this.userTranscripts.push(event);
  }
}

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

  it("includes prior turns in the LLM prompt on follow-up EndOfTurn", async () => {
    const prevCooldown = process.env.ALFRED_ECHO_COOLDOWN_MS;
    process.env.ALFRED_ECHO_COOLDOWN_MS = "0";
    try {
      const clock = new FakeClock();
      const persistence = createInMemoryPersistence();
      const events = new EventLedger(persistence.events, clock, new NoopObservability());
      const sessionId = "sess_history";
      const fsm = new ConversationStateMachine(sessionId, events);
      await fsm.force("Listening", "start");
      const responseLedger = new ResponseLedger(persistence.responseLedgers, events, clock);
      const registry = new ProviderRegistry();
      const stt = new FakeStreamingSTTProvider();
      const llm = new FakeLLMProvider("llm.fake", {
        reply: (user) =>
          /yes/i.test(user)
            ? "Playing the briefing now."
            : "Would you like the daily briefing now?",
      });
      registry.registerStt(stt);
      registry.registerLlm(llm);
      registry.registerTts(new FakeMultiContextTTSProvider());
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
        sttSessionFactory: async () => stt.openSession(),
        ttsSessionFactory: async () =>
          registry.getTts("tts.fake.multicontext").openMultiContextSession!(),
      });
      await voice.start();
      const session = stt.lastSession.current!;

      session.pushEvent({
        type: "end_of_turn",
        text: "Hey Alfred, how are you?",
        metadata: {},
      });
      await new Promise((r) => setTimeout(r, 80));

      session.pushEvent({
        type: "end_of_turn",
        text: "Yes, please. I would.",
        metadata: {},
      });
      await new Promise((r) => setTimeout(r, 80));

      expect(llm.requests.length).toBeGreaterThanOrEqual(2);
      const followUp = llm.requests[llm.requests.length - 1]!;
      const roles = followUp.messages.map((m) => m.role);
      expect(roles).toContain("assistant");
      expect(
        followUp.messages.some((m) => m.role === "assistant" && /briefing/i.test(m.content)),
      ).toBe(true);
      expect(
        followUp.messages.some((m) => m.role === "user" && /Yes, please/i.test(m.content)),
      ).toBe(true);

      await voice.stop();
    } finally {
      if (prevCooldown === undefined) delete process.env.ALFRED_ECHO_COOLDOWN_MS;
      else process.env.ALFRED_ECHO_COOLDOWN_MS = prevCooldown;
    }
  });
});

describe("parseUiCommand", () => {
  function encode(obj: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj));
  }

  it("parses layout, dictate, and text commands", () => {
    expect(
      parseUiCommand(encode({ v: 1, channel: "alfred.control", type: "layout", layout: "chat" })),
    ).toEqual({ type: "layout", layout: "chat" });
    expect(
      parseUiCommand(encode({ v: 1, channel: "alfred.control", type: "dictate", active: true })),
    ).toEqual({ type: "dictate", active: true });
    expect(
      parseUiCommand(encode({ v: 1, channel: "alfred.control", type: "text", text: "hello" })),
    ).toEqual({ type: "text", text: "hello" });
  });

  it("rejects other topics and malformed payloads", () => {
    expect(
      parseUiCommand(
        encode({ channel: "alfred.control", type: "layout", layout: "chat" }),
        "alfred.user",
      ),
    ).toBeUndefined();
    expect(
      parseUiCommand(encode({ channel: "alfred.caption", type: "start", text: "x" })),
    ).toBeUndefined();
    expect(parseUiCommand(new TextEncoder().encode("not-json"))).toBeUndefined();
  });
});

describe("VoiceSessionController chat layout and text turns", () => {
  async function setup(reply = "Silent typed reply.") {
    const clock = new FakeClock();
    const persistence = createInMemoryPersistence();
    const events = new EventLedger(persistence.events, clock, new NoopObservability());
    const sessionId = "sess_chat";
    const fsm = new ConversationStateMachine(sessionId, events);
    await fsm.force("Listening", "start");
    const responseLedger = new ResponseLedger(persistence.responseLedgers, events, clock);
    const registry = new ProviderRegistry();
    const stt = new FakeStreamingSTTProvider();
    const llm = new FakeLLMProvider("llm.fake", { reply });
    registry.registerStt(stt);
    registry.registerLlm(llm);
    registry.registerTts(new FakeMultiContextTTSProvider());
    const memory = new MemoryController("p1", persistence.memorySettings);
    memory.register(new FakeMemoryProvider());
    await memory.initialize();
    const media = new RecordingMediaPort();
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
      media,
      sttSessionFactory: async () => stt.openSession(),
      ttsSessionFactory: async () =>
        registry.getTts("tts.fake.multicontext").openMultiContextSession!(),
    });
    await voice.start();
    return { voice, stt, events, sessionId, media, llm, memory };
  }

  it("commits a typed turn with captions and no TTS audio", async () => {
    const { voice, events, sessionId, media } = await setup();
    await voice.handleUserText("What is on my calendar?");
    const commits = (await events.list(sessionId)).filter((e) => e.type === "turn.committed");
    expect(commits).toHaveLength(1);
    expect((commits[0]?.payload as { source?: string; text?: string }).source).toBe("text");
    expect((commits[0]?.payload as { text?: string }).text).toBe("What is on my calendar?");
    expect(media.pcmFrames).toBe(0);
    expect(media.captions.some((c) => c.type === "start")).toBe(true);
    expect(media.captions.some((c) => c.type === "reveal")).toBe(true);
    expect(media.captions.some((c) => c.type === "end")).toBe(true);
    const revealed = media.captions.filter((c) => c.type === "reveal");
    expect(revealed.at(-1)).toMatchObject({ type: "reveal", text: "Silent typed reply." });
    await voice.stop();
  });

  it("does not auto-commit STT while chat layout is active", async () => {
    const { voice, stt, events, sessionId, media } = await setup();
    voice.handleUiCommand({ type: "layout", layout: "chat" });
    const session = stt.lastSession.current!;
    session.pushEvent({ type: "end_of_turn", text: "this should not commit", metadata: {} });
    await new Promise((r) => setTimeout(r, 40));
    const commits = (await events.list(sessionId)).filter((e) => e.type === "turn.committed");
    expect(commits).toHaveLength(0);
    expect(media.userTranscripts).toHaveLength(0);
    await voice.stop();
  });

  it("publishes dictation transcripts in chat layout without committing", async () => {
    const { voice, stt, events, sessionId, media } = await setup();
    voice.handleUiCommand({ type: "layout", layout: "chat" });
    voice.handleUiCommand({ type: "dictate", active: true });
    const session = stt.lastSession.current!;
    session.pushEvent({ type: "partial_transcript", text: "remember the", metadata: {} });
    session.pushEvent({ type: "end_of_turn", text: "remember the wine", metadata: {} });
    await new Promise((r) => setTimeout(r, 40));
    expect(
      media.userTranscripts.some((t) => t.type === "partial" && t.text === "remember the"),
    ).toBe(true);
    expect(
      media.userTranscripts.some((t) => t.type === "final" && t.text === "remember the wine"),
    ).toBe(true);
    const commits = (await events.list(sessionId)).filter((e) => e.type === "turn.committed");
    expect(commits).toHaveLength(0);
    expect(media.pcmFrames).toBe(0);
    await voice.stop();
  });

  it("still auto-commits spoken turns in voice layout", async () => {
    const { voice, stt, events, sessionId, media } = await setup();
    voice.handleUiCommand({ type: "layout", layout: "voice" });
    const session = stt.lastSession.current!;
    session.pushEvent({ type: "end_of_turn", text: "Hello Alfred", metadata: {} });
    await new Promise((r) => setTimeout(r, 80));
    const commits = (await events.list(sessionId)).filter((e) => e.type === "turn.committed");
    expect(commits).toHaveLength(1);
    expect((commits[0]?.payload as { source?: string }).source).toBe("stt.end_of_turn");
    expect(media.pcmFrames).toBeGreaterThan(0);
    await voice.stop();
  });

  it("routes alfred.control text commands into a silent turn", async () => {
    const { voice, events, sessionId, media } = await setup();
    voice.handleUiCommand({ type: "text", text: "typed via control" });
    await new Promise((r) => setTimeout(r, 80));
    const commits = (await events.list(sessionId)).filter((e) => e.type === "turn.committed");
    expect(commits).toHaveLength(1);
    expect((commits[0]?.payload as { source?: string; text?: string }).text).toBe(
      "typed via control",
    );
    expect(media.pcmFrames).toBe(0);
    await voice.stop();
  });
});
