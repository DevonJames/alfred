import { describe, expect, it } from "vitest";
import { getBriefingDayKey, timeOfDayGreeting } from "./day.js";

describe("getBriefingDayKey", () => {
  const tz = "America/Los_Angeles";

  it("uses previous civil date before 04:30 local", () => {
    // 2026-08-10 03:00 PDT = 2026-08-10T10:00:00.000Z
    const now = new Date("2026-08-10T10:00:00.000Z");
    expect(getBriefingDayKey(now, tz, "04:30")).toBe("2026-08-09");
  });

  it("uses current civil date at/after 04:30 local", () => {
    // 2026-08-10 05:00 PDT = 2026-08-10T12:00:00.000Z
    const now = new Date("2026-08-10T12:00:00.000Z");
    expect(getBriefingDayKey(now, tz, "04:30")).toBe("2026-08-10");
  });

  it("late night after midnight still belongs to prior briefing day", () => {
    // 2026-08-11 01:00 PDT = 2026-08-11T08:00:00.000Z
    const now = new Date("2026-08-11T08:00:00.000Z");
    expect(getBriefingDayKey(now, tz, "04:30")).toBe("2026-08-10");
  });
});

describe("timeOfDayGreeting", () => {
  it("returns morning before noon local", () => {
    const now = new Date("2026-08-10T16:00:00.000Z"); // 09:00 PDT
    expect(timeOfDayGreeting(now, "America/Los_Angeles")).toBe("Good morning");
  });
});
