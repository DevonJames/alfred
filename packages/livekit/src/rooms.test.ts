import { describe, expect, it } from "vitest";
import { isEphemeralLiveRoom } from "./rooms.js";

describe("isEphemeralLiveRoom", () => {
  it("allows Talk and AlfredBot rooms", () => {
    expect(isEphemeralLiveRoom("alfred-bot-187c171e")).toBe(true);
    expect(isEphemeralLiveRoom("alfred-ios-abc-live-xyz")).toBe(true);
    expect(isEphemeralLiveRoom("alfred-live-k2m9q1")).toBe(true);
  });

  it("protects the cascade room and empty names", () => {
    expect(isEphemeralLiveRoom("alfred-dev")).toBe(false);
    expect(isEphemeralLiveRoom("")).toBe(false);
    expect(isEphemeralLiveRoom("  ")).toBe(false);
    expect(isEphemeralLiveRoom("some-other-room")).toBe(false);
  });
});
