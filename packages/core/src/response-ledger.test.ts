import { describe, expect, it } from "vitest";
import { createInMemoryPersistence } from "@alfred/persistence";
import { FakeClock } from "./clock.js";
import { EventLedger } from "./event-ledger.js";
import { NoopObservability } from "./observability.js";
import { ResponseLedger } from "./response-ledger.js";

describe("ResponseLedger", () => {
  it("tracks delivered vs unspoken separately", async () => {
    const clock = new FakeClock();
    const persistence = createInMemoryPersistence();
    const events = new EventLedger(persistence.events, clock, new NoopObservability());
    const ledger = new ResponseLedger(persistence.responseLedgers, events, clock);
    const responseId = ledger.beginResponse("sess", "turn");
    await ledger.appendProposed(responseId, "Hello world. More text here.");
    await ledger.commit(responseId);
    await ledger.markDelivered(responseId, "Hello world. ");
    expect(ledger.getDeliveredText(responseId)).toBe("Hello world. ");
    expect(ledger.getUnspokenRemainder(responseId)).toBe("More text here.");
    await ledger.abandon(responseId, "More text here.", "interruption");
    const snap = ledger.snapshot(responseId);
    expect(snap.abandonedText).toBe("More text here.");
    expect(snap.cancellationReasons).toContain("interruption");
  });
});
