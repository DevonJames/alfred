import { describe, expect, it } from "vitest";
import { formatBriefingForDisplay } from "./display.js";
import type { BriefingData } from "./types.js";

function sample(): BriefingData {
  return {
    greeting: "Good morning",
    date: "Wednesday, October 8, 2026",
    dayKey: "2026-10-08",
    weather: {
      location: "Los Angeles",
      latitude: 34,
      longitude: -118,
      timezone: "America/Los_Angeles",
      current: {
        temperature: 48,
        feelsLike: 45,
        humidity: 85,
        windSpeed: 3,
        windDirection: 180,
        condition: "Clear sky",
        conditionCode: 0,
        isDay: false,
      },
      daily: [
        {
          date: "2026-10-08",
          tempMax: 55,
          tempMin: 44,
          condition: "Clear sky",
          conditionCode: 0,
          precipProbability: 0,
        },
        {
          date: "2026-10-09",
          tempMax: 60,
          tempMin: 46,
          condition: "Partly cloudy",
          conditionCode: 2,
          precipProbability: 10,
        },
        {
          date: "2026-10-10",
          tempMax: 58,
          tempMin: 45,
          condition: "Overcast",
          conditionCode: 3,
          precipProbability: 20,
        },
      ],
      unit: "fahrenheit",
    },
    weatherText: null,
    launches: [],
    launchesText: null,
    markets: {
      crypto: { price: 84_200, change24h: 1.8 },
      cryptoId: "bitcoin",
      index: null,
      indexSymbol: null,
      metals: null,
      metalSymbol: null,
      lines: ["Bitcoin: $84,200 (+1.8%)"],
    },
    marketsText: null,
    news: [{ title: "Example headline", source: "AP News" }],
    newsText: null,
    xIngest: null,
    xIngestText: null,
    agenda: [
      {
        title: "Work on Cora",
        start: "2026-10-08T15:00:00.000Z",
        end: "2026-10-08T19:00:00.000Z",
      },
    ],
    taskReminders: [
      { title: "Follow up on monster truck claim", overdue: false },
      { title: "Speak to the IRS", overdue: true },
    ],
    reminders: [],
    remindersText: null,
    generated: "2026-10-08T08:18:00.000Z",
  };
}

describe("formatBriefingForDisplay", () => {
  it("builds scannable data blocks in agenda → due → markets order", () => {
    const display = formatBriefingForDisplay(sample(), {
      now: new Date("2026-10-08T08:18:00.000Z"),
      timezone: "America/Los_Angeles",
    });
    expect(display.when).toMatch(/Thursday 10\/8 @ 1:18am/);
    const ids = display.sections.map((s) => s.id);
    expect(ids.indexOf("agenda")).toBeLessThan(ids.indexOf("due"));
    expect(ids.indexOf("due")).toBeLessThan(ids.indexOf("markets"));
    expect(display.sections.find((s) => s.id === "weather")?.lines[0]?.text).toMatch(
      /Today: 48 degrees & clear \(feels like 45\) - very humid/,
    );
    expect(display.sections.find((s) => s.id === "agenda")?.lines[0]?.text).toMatch(/Work on Cora/);
    expect(display.sections.find((s) => s.id === "due")?.lines.map((l) => l.text)).toContain(
      "Follow up on monster truck claim",
    );
    expect(display.sections.find((s) => s.id === "open")?.lines.map((l) => l.text)).toContain(
      "Speak to the IRS",
    );
    expect(display.sections.find((s) => s.id === "markets")?.lines[0]?.text).toContain("Bitcoin");
    // Headlines stay off the HUD until the user accepts the spoken offer.
    expect(display.sections.find((s) => s.id === "headlines")).toBeUndefined();

    const withNews = formatBriefingForDisplay(sample(), {
      now: new Date("2026-10-08T08:18:00.000Z"),
      timezone: "America/Los_Angeles",
      includeHeadlines: true,
    });
    const headline = withNews.sections.find((s) => s.id === "headlines")?.lines[0];
    expect(headline?.text).toMatch(/^First:/);
    expect(headline?.newsIndex).toBe(1);
    expect(headline?.newsTitle).toBe("Example headline");
  });
});
