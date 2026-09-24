import { describe, expect, it } from "vitest";
import { formatCurrentTimeSpeech, lookupCurrentTime, resolveSpokenTimezone } from "./clock-lookup.js";

describe("current time speech", () => {
  const now = new Date("2026-09-24T03:37:00.000Z");

  it("speaks the home clock in the briefing timezone", () => {
    expect(
      formatCurrentTimeSpeech({
        now,
        timezone: "America/Los_Angeles",
        kind: "time",
      }),
    ).toBe("It's 8 37 pm on Wednesday, pacific daylight time.");
  });

  it("speaks a named city", () => {
    expect(resolveSpokenTimezone("Tokyo")).toBe("Asia/Tokyo");
    expect(
      formatCurrentTimeSpeech({
        now,
        timezone: "Asia/Tokyo",
        kind: "time",
        placeLabel: "Tokyo",
      }),
    ).toMatch(/^In Tokyo, it's 12 37 pm on Thursday/);
  });

  it("uses the briefing timezone when no place is named", async () => {
    const speech = await lookupCurrentTime(
      {},
      { timezone: "America/New_York" },
      now,
    );
    expect(speech).toBe("It's 11 37 pm on Wednesday, eastern daylight time.");
  });

  it("falls back to home when the city is unknown", async () => {
    const speech = await lookupCurrentTime(
      { place: "Atlantis" },
      { timezone: "America/Los_Angeles" },
      now,
    );
    expect(speech).toMatch(/don't know the timezone for Atlantis/);
    expect(speech).toMatch(/8 37 pm/);
  });
});
