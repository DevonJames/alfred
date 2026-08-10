import { describe, expect, it } from "vitest";
import { formatBriefingForSpeech } from "./format.js";
import type { BriefingData } from "./types.js";

function sample(): BriefingData {
  return {
    greeting: "Good morning",
    date: "Sunday, August 9, 2026",
    dayKey: "2026-08-09",
    weather: {
      location: "Los Angeles, California",
      latitude: 34,
      longitude: -118,
      timezone: "America/Los_Angeles",
      current: {
        temperature: 68,
        feelsLike: 68,
        humidity: 40,
        windSpeed: 5,
        windDirection: 180,
        condition: "Clear sky",
        conditionCode: 0,
        isDay: true,
      },
      daily: [
        {
          date: "2026-08-09",
          tempMax: 75,
          tempMin: 60,
          condition: "Clear sky",
          conditionCode: 0,
          precipProbability: 0,
        },
        {
          date: "2026-08-10",
          tempMax: 77,
          tempMin: 61,
          condition: "Partly cloudy",
          conditionCode: 2,
          precipProbability: 10,
        },
      ],
      unit: "fahrenheit",
    },
    weatherText: null,
    launches: [
      {
        name: "Starlink",
        mission: "Starlink Group 10",
        provider: "SpaceX",
        rocket: "Falcon 9",
        location: "Vandenberg",
        net: "2026-08-12T19:00:00.000Z",
        status: "Go",
      },
    ],
    launchesText: null,
    markets: {
      crypto: { price: 100_000, change24h: 1.2 },
      cryptoId: "bitcoin",
      index: null,
      indexSymbol: null,
      metals: null,
      metalSymbol: null,
      lines: ["Bitcoin: $100,000 (+1.2%)"],
    },
    marketsText: null,
    news: ["Example headline about CA vs TX"],
    newsText: null,
    reminders: [],
    remindersText: "You asked me to remind you: Call Sarah.",
    generated: "2026-08-09T12:00:00.000Z",
  };
}

describe("formatBriefingForSpeech", () => {
  it("builds spoken narrative without screen shorthand", () => {
    const speech = formatBriefingForSpeech(sample(), {
      now: new Date("2026-08-10T16:00:00.000Z"),
      timezone: "America/Los_Angeles",
    });
    expect(speech).toContain("Good morning, sir");
    // 2026-08-10T16:00:00Z = 9:00 am Pacific
    expect(speech).toContain("It is Monday, August 10 at 9:00 am.");
    expect(speech).toContain("Call Sarah");
    expect(speech).toMatch(/Bitcoin is up 1\.2 percent/);
    expect(speech).toContain("thousand dollars");
    expect(speech).toContain("SpaceX");
    expect(speech).toMatch(/noon|midnight|\d+ (thirty )?(am|pm)/i);
    expect(speech).not.toMatch(/\$/);
    expect(speech).not.toMatch(/%/);
    expect(speech).not.toMatch(/\[icon:/);
    expect(speech).toMatch(/Have a (productive day|good afternoon|pleasant evening)/);
  });
});
