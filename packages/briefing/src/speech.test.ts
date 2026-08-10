import { describe, expect, it } from "vitest";
import {
  sanitizeForSpeech,
  speakClockTime,
  speakPercentChange,
  speakUsdAmount,
  speakWallClock,
} from "./speech.js";

describe("speakUsdAmount", () => {
  it("speaks thousands without dollar signs", () => {
    expect(speakUsdAmount(100_000)).toBe("100 thousand dollars");
    expect(speakUsdAmount(95_600)).toBe("95 thousand 600 dollars");
    expect(speakUsdAmount(42)).toBe("42 dollars");
  });
});

describe("speakClockTime", () => {
  it("uses noon and thirty phrasing", () => {
    expect(speakClockTime(new Date("2026-08-10T19:00:00.000Z"), "America/Los_Angeles")).toBe(
      "noon",
    );
    expect(speakClockTime(new Date("2026-08-10T22:30:00.000Z"), "America/Los_Angeles")).toBe(
      "3 thirty pm",
    );
  });
});

describe("speakWallClock", () => {
  it("formats h:mm am/pm", () => {
    expect(speakWallClock(new Date("2026-08-10T05:17:00.000Z"), "America/Los_Angeles")).toBe(
      "10:17 pm",
    );
  });
});

describe("speakPercentChange", () => {
  it("returns direction words", () => {
    expect(speakPercentChange(2.3)).toEqual({ direction: "up", amount: "2.3" });
    expect(speakPercentChange(-1.0)).toEqual({ direction: "down", amount: "1.0" });
  });
});

describe("sanitizeForSpeech", () => {
  it("expands abbreviations and strips symbols", () => {
    const out = sanitizeForSpeech("S&P 500 vs CA — Bitcoin $100,000 (+2.3%)");
    expect(out).toContain("S and P 500");
    expect(out).toContain("versus");
    expect(out).toContain("California");
    expect(out).toContain("thousand dollars");
    expect(out).toContain("percent");
    expect(out).not.toContain("$");
    expect(out).not.toContain("%");
  });
});
