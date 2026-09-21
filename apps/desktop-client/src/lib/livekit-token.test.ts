import { describe, expect, it } from "vitest";
import {
  liveKitIdentityPrefix,
  liveKitParticipantIdentity,
  resolveLiveKitRoomName,
  robotLiveRoomName,
  shouldDispatchLiveAgent,
  usesSharedRobotRoom,
} from "./livekit-token.js";

describe("liveKitIdentityPrefix", () => {
  it("maps robot aliases to alfred-robot", () => {
    expect(liveKitIdentityPrefix("robot")).toBe("alfred-robot");
    expect(liveKitIdentityPrefix("alfredbot")).toBe("alfred-robot");
  });

  it("keeps iOS as the session default", () => {
    expect(liveKitIdentityPrefix(undefined)).toBe("alfred-ios");
    expect(liveKitIdentityPrefix("")).toBe("alfred-ios");
    expect(liveKitIdentityPrefix("ios")).toBe("alfred-ios");
  });
});

describe("shared robot room", () => {
  it("treats robot clients and join=robot as the shared room", () => {
    expect(usesSharedRobotRoom({ client: "robot" })).toBe(true);
    expect(usesSharedRobotRoom({ client: "ios", join: "robot" })).toBe(true);
    expect(usesSharedRobotRoom({ client: "ios" })).toBe(false);
  });

  it("derives a stable room from the desktop id", () => {
    expect(robotLiveRoomName("abcdef12-xxxx-yyyy")).toBe("alfred-bot-abcdef12");
    expect(robotLiveRoomName(null)).toBe("alfred-bot-local");
  });

  it("reuses one robot identity so rematch does not stack peers", () => {
    expect(liveKitParticipantIdentity("alfred-robot", "abcdef12-xxxx")).toBe("alfred-robot-abcdef12");
    expect(liveKitParticipantIdentity("alfred-robot", null)).toBe("alfred-robot-local");
    expect(liveKitParticipantIdentity("alfred-ios", "abcdef12-xxxx")).toMatch(/^alfred-ios-[a-z0-9]+$/);
  });

  it("uses the stable bot room for live robot / phone-audio joins", () => {
    expect(
      resolveLiveKitRoomName({
        live: true,
        client: "robot",
        desktopClientId: "abcdef12-xxxx",
        fallbackRoom: "should-not-use",
      }),
    ).toBe("alfred-bot-abcdef12");
    expect(
      resolveLiveKitRoomName({
        live: true,
        client: "ios",
        join: "robot",
        desktopClientId: "xyz99999-aaaa",
        fallbackRoom: "nope",
      }),
    ).toBe("alfred-bot-xyz99999");
  });

  it("keeps cascade on the existing shared cascade room", () => {
    expect(
      resolveLiveKitRoomName({
        live: false,
        client: "robot",
        join: "robot",
        fallbackRoom: "alfred-dev",
      }),
    ).toBe("alfred-dev");
  });

  it("does not wake GPT-Live when only the robot joins", () => {
    expect(shouldDispatchLiveAgent("robot")).toBe(false);
    expect(shouldDispatchLiveAgent("ios")).toBe(true);
    expect(shouldDispatchLiveAgent(undefined)).toBe(true);
  });

  it("wakes GPT-Live when the robot face starts a local Talk", () => {
    expect(shouldDispatchLiveAgent("robot", true)).toBe(true);
  });

  it("skips dispatch when the caller opts out (HTTP conversation poll)", () => {
    expect(shouldDispatchLiveAgent("ios", false)).toBe(false);
    expect(shouldDispatchLiveAgent(undefined, false)).toBe(false);
    expect(shouldDispatchLiveAgent("ios", true)).toBe(true);
  });

  it("leaves ordinary iOS Talk on the unique live room", () => {
    expect(
      resolveLiveKitRoomName({
        live: true,
        client: "ios",
        fallbackRoom: "alfred-live-abc123",
      }),
    ).toBe("alfred-live-abc123");
  });
});
