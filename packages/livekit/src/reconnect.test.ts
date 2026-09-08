import { describe, expect, it } from "vitest";
import { nextReconnectDelayMs } from "./reconnect.js";
import { isAgentInRoom } from "./agent-presence.js";

describe("LiveKit reconnect backoff", () => {
  it("ramps from 250ms then caps at 60s", () => {
    expect(nextReconnectDelayMs(0)).toBe(250);
    expect(nextReconnectDelayMs(1)).toBe(1_000);
    expect(nextReconnectDelayMs(6)).toBe(60_000);
    expect(nextReconnectDelayMs(99)).toBe(60_000);
  });
});

describe("isAgentInRoom", () => {
  it("returns false for unreachable hosts without throwing", async () => {
    await expect(
      isAgentInRoom({
        url: "wss://example.invalid",
        apiKey: "k",
        apiSecret: "s",
        roomName: "r",
        identity: "alfred-agent",
      }),
    ).resolves.toBe(false);
  });
});
