import { describe, expect, it } from "vitest";
import { mapFluxMessage } from "./flux-stt.js";

describe("mapFluxMessage", () => {
  it("maps Flux TurnInfo EagerEndOfTurn", () => {
    const events = mapFluxMessage({
      type: "TurnInfo",
      event: "EagerEndOfTurn",
      transcript: "hello there",
      confidence: 0.55,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "eager_end_of_turn",
        text: "hello there",
        eagerEotConfidence: 0.55,
      }),
    ]);
  });

  it("maps Flux TurnInfo TurnResumed and EndOfTurn", () => {
    expect(
      mapFluxMessage({
        type: "TurnInfo",
        event: "TurnResumed",
        transcript: "hello there friend",
      })[0]?.type,
    ).toBe("turn_resumed");
    expect(
      mapFluxMessage({ type: "TurnInfo", event: "EndOfTurn", transcript: "done" })[0]?.type,
    ).toBe("end_of_turn");
  });

  it("maps Flux TurnInfo StartOfTurn and Update partials", () => {
    expect(
      mapFluxMessage({ type: "TurnInfo", event: "StartOfTurn", transcript: "hi" })[0]?.type,
    ).toBe("start_of_turn");
    expect(
      mapFluxMessage({ type: "TurnInfo", event: "Update", transcript: "hi there" })[0],
    ).toMatchObject({ type: "partial_transcript", text: "hi there" });
  });

  it("ignores Connected envelopes", () => {
    expect(mapFluxMessage({ type: "Connected" })).toEqual([]);
  });
});
