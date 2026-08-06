import { describe, expect, it } from "vitest";
import { createInMemoryPersistence } from "@alfred/persistence";
import { FakeClock } from "./clock.js";
import { EventLedger } from "./event-ledger.js";
import { NoopObservability } from "./observability.js";
import { ConversationStateMachine, InvalidTransitionError } from "./state-machine.js";

describe("ConversationStateMachine", () => {
  it("emits structured transition events", async () => {
    const clock = new FakeClock();
    const persistence = createInMemoryPersistence();
    const events = new EventLedger(persistence.events, clock, new NoopObservability());
    const fsm = new ConversationStateMachine("sess", events);
    await fsm.transition("Listening", "start");
    await fsm.transition("UserSpeechDetected", "speech");
    const list = await events.list("sess");
    expect(list.filter((e) => e.type === "state.transition")).toHaveLength(2);
    expect(list[0]?.payload).toMatchObject({ from: "Idle", to: "Listening" });
  });

  it("rejects illegal transitions", async () => {
    const clock = new FakeClock();
    const persistence = createInMemoryPersistence();
    const events = new EventLedger(persistence.events, clock, new NoopObservability());
    const fsm = new ConversationStateMachine("sess", events);
    await expect(fsm.transition("AssistantSpeaking", "bad")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });
});
