import type { PipelineConfiguration } from "@alfred/contracts";
import { createWorld, type SimulatorWorld } from "./harness.js";

export interface ScenarioResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

type ScenarioFn = () => Promise<ScenarioResult>;

async function withWorld(
  id: string,
  name: string,
  opts: Parameters<typeof createWorld>[0],
  run: (world: SimulatorWorld) => Promise<string>,
): Promise<ScenarioResult> {
  try {
    const world = await createWorld(opts);
    const detail = await run(world);
    return { id, name, passed: true, detail };
  } catch (err) {
    const detail =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err && "reason" in err
          ? `abort:${String((err as { reason: unknown }).reason)}`
          : JSON.stringify(err);
    return { id, name, passed: false, detail };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Await a session promise while advancing the fake clock.
 * Prevents deadlock when work registers sleeps after the caller would otherwise finish draining.
 */
export async function awaitWithClock<T>(
  world: SimulatorWorld,
  promise: Promise<T>,
  maxMs = 5_000,
): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    },
  );
  const step = 10;
  for (let t = 0; t < maxMs && !settled; t += step) {
    await world.clock.advance(step);
  }
  if (!settled) {
    throw new Error(`Timed out after ${maxMs}ms waiting for session work (fake clock)`);
  }
  return tracked;
}

async function runTurn(world: SimulatorWorld, text: string): Promise<void> {
  await awaitWithClock(world, world.session.handleUserUtterance({ text }));
}

async function advanceUntil(
  world: SimulatorWorld,
  predicate: () => boolean,
  maxMs = 5_000,
): Promise<void> {
  for (let t = 0; t < maxMs; t += 10) {
    if (predicate()) return;
    await world.clock.advance(10);
    // Flush microtasks/macrotasks so session awaits can progress between ticks.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Predicate not met within ${maxMs}ms (state=${world.session.getState()})`);
}

const cascadedSettings = {
  connectionTimeoutMs: 1000,
  firstTokenTimeoutMs: 1000,
  totalRequestTimeoutMs: 5000,
  consecutiveFailureThreshold: 1,
  cooldownMs: 10_000,
  retryPrimaryIntervalMs: 60_000,
  manualPin: false,
} as const;

export const scenarios: ScenarioFn[] = [
  () =>
    withWorld("01", "Normal conversational turn", {}, async (w) => {
      await runTurn(w, "Hello Alfred");
      const events = await w.session.getEvents();
      assert(
        events.some((e) => e.type === "turn.committed"),
        "expected turn.committed",
      );
      assert(
        w.session.getState() === "Listening" || w.session.getState() === "Idle",
        "expected idle/listening",
      );
      return `state=${w.session.getState()} events=${events.length}`;
    }),

  () =>
    withWorld(
      "02",
      "Memory retrieval added to prompt",
      { memorySeed: [{ content: "User's favorite color is teal." }] },
      async (w) => {
        await runTurn(w, "What is my favorite color?");
        const events = await w.session.getEvents();
        assert(
          events.some((e) => e.type === "memory.retrieved"),
          "memory.retrieved missing",
        );
        const memEvent = events.find((e) => e.type === "memory.retrieved");
        assert((memEvent?.payload.count as number) >= 1, "expected memory items");
        return `retrieved=${memEvent?.payload.count}`;
      },
    ),

  () =>
    withWorld(
      "03",
      "LLM primary failure and sticky fallback",
      { llmPrimaryFailTimes: 2 },
      async (w) => {
        await runTurn(w, "First question");
        assert(
          w.session.snapshot().activeLlmProviderId === "llm.secondary",
          "should stick on secondary",
        );
        await runTurn(w, "Second question");
        assert(
          w.session.snapshot().activeLlmProviderId === "llm.secondary",
          "should remain sticky",
        );
        assert(w.llmSecondary.getCallCount() >= 2, "secondary should serve later turns");
        return `active=${w.session.snapshot().activeLlmProviderId}`;
      },
    ),

  () =>
    withWorld(
      "04",
      "Manual request to check the primary",
      { llmPrimaryFailTimes: 1 },
      async (w) => {
        await runTurn(w, "Fail over please");
        assert(w.session.snapshot().activeLlmProviderId === "llm.secondary", "on secondary");
        w.llmPrimary.setHealthy(true);
        const restored = await w.session.checkPrimaryLlm();
        assert(restored, "manual check should restore primary");
        assert(w.session.snapshot().activeLlmProviderId === "llm.primary", "primary restored");
        return "primary restored via manual check";
      },
    ),

  () =>
    withWorld(
      "05",
      "Timeout-based return to primary after health probe",
      { llmPrimaryFailTimes: 1 },
      async (w) => {
        await runTurn(w, "Failover");
        assert(w.session.snapshot().activeLlmProviderId === "llm.secondary", "sticky secondary");
        w.llmPrimary.setHealthy(true);
        await w.clock.advance(60_000);
        const restored = await w.session.maybeRestorePrimaryLlm();
        assert(restored, "interval restore should succeed");
        assert(w.session.snapshot().activeLlmProviderId === "llm.primary", "primary restored");
        return "primary restored after retry interval";
      },
    ),

  () =>
    withWorld("06", "Additional user info during generation", {}, async (w) => {
      w.llmPrimary.setFirstTokenDelayMs(100);
      const turnPromise = w.session.handleUserUtterance({ text: "Tell me about Paris" });
      await advanceUntil(w, () => w.session.getState() === "GeneratingResponse");
      const addendumPromise = w.session.handleUserUtterance({
        text: "Focus on food only",
        asAddendum: true,
      });
      await awaitWithClock(w, Promise.all([turnPromise, addendumPromise]));
      const events = await w.session.getEvents();
      assert(
        events.some((e) => e.type === "turn.addendum"),
        "expected addendum event",
      );
      const responseId = w.session.snapshot().currentResponseId;
      assert(responseId, "expected response");
      const snap = w.session.getResponseLedger().snapshot(responseId!);
      assert(
        snap.segments.some((s) => s.kind === "addendum") || snap.committedText.includes("Addendum"),
        "expected addendum segment",
      );
      return `segments=${snap.segments.length}`;
    }),

  () =>
    withWorld("07", "Genuine interruption during speech delivery", {}, async (w) => {
      const turnPromise = w.session.handleUserUtterance({
        text: "Explain quantum computing in detail please",
      });
      await advanceUntil(w, () => w.session.getState() === "AssistantSpeaking");
      const interruptPromise = w.session.handleUserUtterance({
        text: "Actually wait, tell me about cats instead",
        utteranceKind: "speech",
        forcedArbitration: "abandon_and_answer",
      });
      await awaitWithClock(w, Promise.all([turnPromise, interruptPromise]));
      const events = await w.session.getEvents();
      assert(
        events.some((e) => e.type === "interruption.detected"),
        "interruption.detected",
      );
      assert(
        events.some((e) => e.type === "interruption.arbitrated"),
        "arbitrated",
      );
      return "interruption handled";
    }),

  () =>
    withWorld("08", "Backchannel does not interrupt delivery", {}, async (w) => {
      const turnPromise = w.session.handleUserUtterance({
        text: "Give me a long explanation about railways and locomotives across history",
      });
      await advanceUntil(w, () => w.session.getState() === "AssistantSpeaking");
      const backchannelPromise = w.session.handleUserUtterance({
        text: "uh huh",
        utteranceKind: "backchannel",
      });
      await awaitWithClock(w, Promise.all([turnPromise, backchannelPromise]));
      const events = await w.session.getEvents();
      assert(
        events.some((e) => e.type === "interruption.backchannel"),
        "backchannel event",
      );
      assert(
        !events.some((e) => e.type === "interruption.detected"),
        "should not genuine-interrupt",
      );
      return "backchannel continued speech";
    }),

  () =>
    withWorld("09", "Interruption abandons remaining response", {}, async (w) => {
      const turnPromise = w.session.handleUserUtterance({
        text: "Please narrate a long story about the ocean and ships",
      });
      await advanceUntil(w, () => w.session.getState() === "AssistantSpeaking");
      const interruptPromise = w.session.handleUserUtterance({
        text: "stop, new topic",
        utteranceKind: "speech",
        forcedArbitration: "abandon_and_answer",
      });
      await awaitWithClock(w, Promise.all([turnPromise, interruptPromise]));
      const events = await w.session.getEvents();
      assert(
        events.some((e) => e.type === "response.abandoned"),
        "expected abandoned",
      );
      return "abandoned unspoken remainder";
    }),

  () =>
    withWorld("10", "Interruption finishes sentence then answers", {}, async (w) => {
      const turnPromise = w.session.handleUserUtterance({
        text: "Explain photosynthesis carefully with several sentences.",
      });
      await advanceUntil(w, () => w.session.getState() === "AssistantSpeaking");
      const interruptPromise = w.session.handleUserUtterance({
        text: "quick question about water",
        utteranceKind: "speech",
        forcedArbitration: "finish_sentence_then_answer",
      });
      await awaitWithClock(w, Promise.all([turnPromise, interruptPromise]));
      const events = await w.session.getEvents();
      const arb = events.find((e) => e.type === "interruption.arbitrated");
      assert(arb?.payload.outcome === "finish_sentence_then_answer", "finish sentence outcome");
      return "finished sentence then answered";
    }),

  () =>
    withWorld("11", "Delegation to agent harness by category", {}, async (w) => {
      await runTurn(w, "delegate:coding:refactor the auth module");
      assert(w.codex.getExecutions() === 1, "codex should execute");
      const events = await w.session.getEvents();
      assert(
        events.some((e) => e.type === "agent.delegated"),
        "delegated",
      );
      assert(
        events.some((e) => e.type === "agent.completed"),
        "completed",
      );
      return "codex handled coding task";
    }),

  () =>
    withWorld("12", "Agent-harness failover", { openclawFailTimes: 1 }, async (w) => {
      await runTurn(w, "delegate:email:draft a reply to Alice");
      assert(w.openclaw.getExecutions() === 1, "openclaw attempted");
      assert(w.hermes.getExecutions() === 1, "hermes failover");
      return "email routing failed over to hermes";
    }),

  () =>
    withWorld(
      "13",
      "Unified pipeline locks component selectors",
      {
        pipeline: {
          mode: "unified",
          allowCascadedFallback: false,
          unifiedPriority: {
            modality: "unified",
            orderedProviderIds: ["unified.alpha", "unified.beta"],
            settings: { ...cascadedSettings },
          },
        } satisfies PipelineConfiguration,
      },
      async (w) => {
        const locks = w.session.snapshot().selectorLocks;
        assert(
          locks.every((l) => l.locked),
          "all selectors locked",
        );
        assert(
          locks.every((l) => l.reasonCode === "unified_mode_active"),
          "lock reason unified",
        );
        return locks.map((l) => `${l.selector}:${l.reasonCode}`).join(",");
      },
    ),

  () =>
    withWorld(
      "14",
      "Switch from unified mode back to cascaded",
      {
        pipeline: {
          mode: "unified",
          allowCascadedFallback: false,
          unifiedPriority: {
            modality: "unified",
            orderedProviderIds: ["unified.alpha"],
            settings: { ...cascadedSettings },
          },
        },
      },
      async (w) => {
        await w.session.updatePipeline({
          mode: "cascaded",
          allowCascadedFallback: false,
          sttPriority: {
            modality: "stt",
            orderedProviderIds: ["stt.fake"],
            settings: { ...cascadedSettings },
          },
          llmPriority: {
            modality: "llm",
            orderedProviderIds: ["llm.primary"],
            settings: { ...cascadedSettings },
          },
          ttsPriority: {
            modality: "tts",
            orderedProviderIds: ["tts.fake"],
            settings: { ...cascadedSettings },
          },
        });
        const locks = w.session.snapshot().selectorLocks;
        assert(
          locks.every((l) => !l.locked),
          "selectors unlocked",
        );
        assert(w.session.snapshot().pipelineMode === "cascaded", "cascaded mode");
        return "switched to cascaded; selectors editable";
      },
    ),

  () =>
    withWorld("15", "Changing the active memory provider", {}, async (w) => {
      assert(w.memory.getActiveProviderId() === "memory.fake", "start on fake");
      await w.session.setActiveMemoryProvider("memory.fake.alt");
      assert(w.memory.getActiveProviderId() === "memory.fake.alt", "switched");
      return `active=${w.memory.getActiveProviderId()}`;
    }),
];

export async function runAllScenarios(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await scenario());
  }
  return results;
}
