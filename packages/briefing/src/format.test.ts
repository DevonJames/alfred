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
        {
          date: "2026-08-11",
          tempMax: 74,
          tempMin: 58,
          condition: "Foggy",
          conditionCode: 45,
          precipProbability: 5,
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
    news: [
      {
        title: "Example headline about CA vs TX",
        source: "AP News",
        url: "https://example.com/ca-tx",
      },
    ],
    newsText: null,
    xIngest: null,
    xIngestText: null,
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
    expect(speech).toMatch(/Today, clear sky, high 75, low 60/);
    const withAgenda = formatBriefingForSpeech(
      {
        ...sample(),
        agendaText: "On your agenda today: USPTO from noon to 6 15 pm.",
      },
      {
        now: new Date("2026-08-10T16:00:00.000Z"),
        timezone: "America/Los_Angeles",
      },
    );
    expect(withAgenda).toContain("On your agenda today: USPTO from noon to 6 15 pm.");
    expect(speech).toMatch(/Tomorrow, partly cloudy/);
    expect(speech).toContain("Call Sarah");
    // Reminders sit after agenda / weather and before markets.
    const remAt = speech.indexOf("Call Sarah");
    const btcAt = speech.search(/Bitcoin is up/i);
    expect(remAt).toBeGreaterThan(-1);
    expect(btcAt).toBeGreaterThan(remAt);
    expect(speech).toMatch(/Bitcoin is up 1\.2 percent/);
    expect(speech).toContain("thousand dollars");
    // Built-in launches are parked; a user module supplies this section instead.
    expect(speech).not.toContain("SpaceX");
    expect(speech).toMatch(/noon|midnight|\d+ (thirty )?(am|pm)/i);
    expect(speech).not.toMatch(/\$/);
    expect(speech).not.toMatch(/%/);
    expect(speech).not.toMatch(/\[icon:/);
    // Headlines are offered, not read, in the main brief.
    expect(speech).not.toMatch(/Example headline about CA vs TX/i);
    expect(speech).toMatch(/Have a (productive day|good afternoon|pleasant evening)/);
  });

  it("speaks morning medicine after fitness and before reminders", () => {
    const speech = formatBriefingForSpeech(
      {
        ...sample(),
        agendaText: "On your agenda today: USPTO.",
        fitnessText: "On your training plan today: squats.",
        medicineText: "Morning medicine: Vitamin D, 1 capsule.",
      },
      {
        now: new Date("2026-08-10T16:00:00.000Z"),
        timezone: "America/Los_Angeles",
      },
    );
    const fitness = speech.indexOf("squats");
    const medicine = speech.indexOf("Morning medicine");
    const reminders = speech.indexOf("Call Sarah");
    expect(fitness).toBeGreaterThan(-1);
    expect(medicine).toBeGreaterThan(fitness);
    expect(reminders).toBeGreaterThan(medicine);
  });

  it("speaks user modules after markets", () => {
    const speech = formatBriefingForSpeech(
      {
        ...sample(),
        modules: [
          {
            id: "rocket-launches",
            title: "Rocket launches",
            speech: "There's a SpaceX launch, Starlink, scheduled for Wednesday at noon.",
            lines: ["SpaceX · Starlink — Wed noon"],
          },
        ],
      },
      {
        now: new Date("2026-08-10T16:00:00.000Z"),
        timezone: "America/Los_Angeles",
      },
    );
    const markets = speech.search(/Bitcoin is up/i);
    const launch = speech.indexOf("There's a SpaceX launch");
    expect(markets).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(markets);
  });

  it("ends with the headline offer instead of reading the news", () => {
    const speech = formatBriefingForSpeech(
      {
        ...sample(),
        headlineOffer: "Want me to pull the latest headlines?",
      },
      {
        now: new Date("2026-08-10T16:00:00.000Z"),
        timezone: "America/Los_Angeles",
      },
    );
    expect(speech).toContain("Want me to pull the latest headlines?");
    expect(speech).not.toMatch(/Example headline about CA vs TX/i);
    expect(speech).not.toMatch(/Have a productive day/);
  });
});
