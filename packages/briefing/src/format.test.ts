import { describe, expect, it } from "vitest";
import { formatBriefingForSpeech } from "./format.js";
import type { BriefingData } from "./types.js";

function sample(): BriefingData {
  return {
    greeting: "Good morning",
    date: "Sunday, August 9, 2026",
    dayKey: "2026-08-09",
    weather: null,
    weatherText: "It's clear and 68 degrees Fahrenheit in Los Angeles.",
    launches: [],
    launchesText: "No upcoming launches found.",
    markets: {
      crypto: { price: 100_000, change24h: 1.2 },
      cryptoId: "bitcoin",
      index: null,
      indexSymbol: null,
      metals: null,
      metalSymbol: null,
      lines: ["Bitcoin is about $100,000 (+1.2%)"],
    },
    marketsText: "Markets: Bitcoin is about $100,000 (+1.2%).",
    news: ["Example headline"],
    newsText: "Top headlines: Example headline.",
    reminders: [],
    remindersText: "You asked me to remind you: Call Sarah.",
    generated: "2026-08-09T12:00:00.000Z",
  };
}

describe("formatBriefingForSpeech", () => {
  it("builds TTS-safe narrative without icon tokens", () => {
    const speech = formatBriefingForSpeech(sample());
    expect(speech).toContain("Good morning");
    expect(speech).toContain("Call Sarah");
    expect(speech).toContain("Bitcoin");
    expect(speech).not.toMatch(/\[icon:/);
  });
});
