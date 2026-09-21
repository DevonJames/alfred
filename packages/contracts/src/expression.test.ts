import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPRESSION_TIMEOUT_MS,
  EXPRESSION_TOPIC,
  buildExpressionEvent,
  clampExpressionTimeout,
  parseExpressionPayload,
} from "./expression.js";

describe("expression contract", () => {
  it("clamps timeout to the allowed window", () => {
    expect(clampExpressionTimeout(undefined)).toBe(DEFAULT_EXPRESSION_TIMEOUT_MS);
    expect(clampExpressionTimeout(200)).toBe(1_500);
    expect(clampExpressionTimeout(60_000)).toBe(20_000);
  });

  it("falls back to calm / none for unknown names", () => {
    const event = buildExpressionEvent({ face: "grin", body: "dance", type: "set" });
    expect(event.face).toBe("calm");
    expect(event.body).toBe("none");
    expect(event.type).toBe("clear");
  });

  it("round-trips a wink + nod through the data payload", () => {
    const event = buildExpressionEvent({
      type: "set",
      face: "wink",
      body: "nod",
      timeoutMs: 6_000,
      atMs: 1,
    });
    expect(event.channel).toBe(EXPRESSION_TOPIC);
    const parsed = parseExpressionPayload(new TextEncoder().encode(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });

  it("ignores payloads on another channel", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ v: 1, channel: "alfred.caption", type: "set", face: "smile" }),
    );
    expect(parseExpressionPayload(payload)).toBeUndefined();
  });
});
