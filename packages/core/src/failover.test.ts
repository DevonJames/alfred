import { describe, expect, it } from "vitest";
import { createInMemoryPersistence } from "@alfred/persistence";
import { FakeClock } from "./clock.js";
import { EventLedger } from "./event-ledger.js";
import { StickyFailoverController } from "./failover.js";
import { NoopObservability } from "./observability.js";

describe("StickyFailoverController", () => {
  function setup() {
    const clock = new FakeClock();
    const persistence = createInMemoryPersistence();
    const events = new EventLedger(persistence.events, clock, new NoopObservability());
    const health = new Map<string, "healthy" | "unhealthy">([
      ["a", "healthy"],
      ["b", "healthy"],
      ["c", "healthy"],
    ]);
    const controller = new StickyFailoverController(
      "sess_test",
      {
        modality: "llm",
        orderedProviderIds: ["a", "b", "c"],
        settings: {
          connectionTimeoutMs: 1000,
          firstTokenTimeoutMs: 1000,
          totalRequestTimeoutMs: 5000,
          consecutiveFailureThreshold: 2,
          cooldownMs: 5_000,
          retryPrimaryIntervalMs: 10_000,
          manualPin: false,
        },
      },
      clock,
      events,
      async (id) => ({
        providerId: id,
        status: health.get(id) ?? "unknown",
        checkedAt: clock.nowIso(),
      }),
    );
    return { clock, controller, health, events };
  }

  it("selects the first healthy provider", async () => {
    const { controller } = setup();
    await expect(controller.selectInitial()).resolves.toBe("a");
  });

  it("does not failover before consecutive failure threshold", async () => {
    const { controller } = setup();
    await controller.selectInitial();
    await controller.recordFailure("a", "upstream_5xx");
    expect(controller.getActiveProviderId()).toBe("a");
  });

  it("failovers stickily after threshold and does not bounce to primary", async () => {
    const { controller } = setup();
    await controller.selectInitial();
    await controller.recordFailure("a", "upstream_5xx");
    await controller.recordFailure("a", "upstream_5xx");
    expect(controller.getActiveProviderId()).toBe("b");
    await controller.recordSuccess("b");
    expect(controller.getActiveProviderId()).toBe("b");
  });

  it("restores primary only after retry interval and successful probe", async () => {
    const { controller, clock, health } = setup();
    await controller.selectInitial();
    await controller.recordFailure("a", "timeout_total");
    await controller.recordFailure("a", "timeout_total");
    expect(controller.getActiveProviderId()).toBe("b");

    health.set("a", "unhealthy");
    await clock.advance(10_000);
    await expect(controller.maybeRestorePrimary()).resolves.toBe(false);
    expect(controller.getActiveProviderId()).toBe("b");

    health.set("a", "healthy");
    await expect(controller.maybeRestorePrimary()).resolves.toBe(true);
    expect(controller.getActiveProviderId()).toBe("a");
  });

  it("honors manual checkPrimary", async () => {
    const { controller } = setup();
    await controller.selectInitial();
    await controller.recordFailure("a", "unavailable");
    await controller.recordFailure("a", "unavailable");
    expect(controller.getActiveProviderId()).toBe("b");
    await expect(controller.checkPrimary()).resolves.toBe(true);
    expect(controller.getActiveProviderId()).toBe("a");
  });

  it("respects cooldown when selecting next provider", async () => {
    const { controller, clock } = setup();
    await controller.selectInitial();
    await controller.recordFailure("a", "rate_limit");
    await controller.recordFailure("a", "rate_limit");
    expect(controller.getActiveProviderId()).toBe("b");
    await controller.recordFailure("b", "rate_limit");
    await controller.recordFailure("b", "rate_limit");
    expect(controller.getActiveProviderId()).toBe("c");
    // a still in cooldown
    await controller.recordFailure("c", "rate_limit");
    await controller.recordFailure("c", "rate_limit");
    // all in cooldown — may stay on c
    expect(["a", "b", "c"]).toContain(controller.getActiveProviderId());
    await clock.advance(5_000);
    await controller.checkPrimary();
    expect(controller.getActiveProviderId()).toBe("a");
  });
});
