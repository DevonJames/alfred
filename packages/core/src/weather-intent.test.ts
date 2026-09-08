import { describe, expect, it } from "vitest";
import { looksLikeWeatherTask, parseWeatherIntent } from "./weather-intent.js";

describe("parseWeatherIntent", () => {
  it("treats bare weather asks as home", () => {
    expect(parseWeatherIntent("Hey, Alfred. What is the weather?")).toEqual({
      location: undefined,
      days: undefined,
    });
    expect(parseWeatherIntent("What's the weather look like right now?")).toEqual({
      location: undefined,
      days: undefined,
    });
    expect(parseWeatherIntent("What is the weather right here?")).toEqual({
      location: undefined,
      days: undefined,
    });
  });

  it("extracts another city or zip", () => {
    expect(parseWeatherIntent("What's the weather in Seattle?")).toEqual({
      location: "Seattle",
      days: undefined,
    });
    expect(parseWeatherIntent("forecast for 10001")).toEqual({
      location: "10001",
      days: undefined,
    });
  });

  it("does not match unrelated turns", () => {
    expect(parseWeatherIntent("Remind me to call Mom")).toBeNull();
    expect(parseWeatherIntent("Turn on the lights")).toBeNull();
    expect(looksLikeWeatherTask("What's for dinner?")).toBe(false);
  });
});
