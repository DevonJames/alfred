import { describe, expect, it } from "vitest";
import { parseSituationalIntent } from "./situational-intent.js";
import { parseWeatherIntent } from "./weather-intent.js";

describe("parseSituationalIntent", () => {
  it("parses earthquake asks", () => {
    expect(parseSituationalIntent("Any significant earthquakes today?")).toEqual({
      tool: "earthquakes",
      scope: "significant",
      recent: false,
    });
    expect(parseSituationalIntent("What just shook California?")).toMatchObject({
      tool: "earthquakes",
      recent: true,
      place: "California",
    });
  });

  it("parses weather alerts ahead of the forecast wording", () => {
    expect(parseSituationalIntent("Any severe weather near home?")).toEqual({
      tool: "weather_alerts",
    });
    expect(parseWeatherIntent("Any severe weather near home?")).toBeNull();
    expect(parseSituationalIntent("What warnings are active around DC?")).toMatchObject({
      tool: "weather_alerts",
      location: "DC",
    });
  });

  it("parses space weather without treating it as a forecast", () => {
    expect(parseSituationalIntent("Is there a geomagnetic storm?")).toEqual({
      tool: "space_weather",
    });
    expect(parseSituationalIntent("Could we see aurora tonight?")).toEqual({
      tool: "space_weather",
    });
    expect(parseWeatherIntent("What's the space weather?")).toBeNull();
  });

  it("parses wildfires and volcanoes", () => {
    expect(parseSituationalIntent("Where are the major wildfires right now?")).toEqual({
      tool: "natural_events",
      kind: "wildfires",
    });
    expect(parseSituationalIntent("Any volcanoes erupting?")).toEqual({
      tool: "natural_events",
      kind: "volcanoes",
    });
  });

  it("parses currency conversion and leaves bitcoin to markets", () => {
    expect(parseSituationalIntent("What's $500 in euros?")).toEqual({
      tool: "exchange_rate",
      amount: 500,
      from: "USD",
      to: "EUR",
      change: false,
    });
    expect(parseSituationalIntent("How much has the yen moved?")).toMatchObject({
      tool: "exchange_rate",
      from: "USD",
      to: "JPY",
      change: true,
    });
    expect(parseSituationalIntent("What's bitcoin at?")).toBeNull();
  });

  it("parses Hacker News without stealing the general news ask", () => {
    expect(parseSituationalIntent("What are developers talking about today?")).toEqual({
      tool: "hacker_news",
      topic: "general",
    });
    expect(parseSituationalIntent("Anything interesting in AI?")).toEqual({
      tool: "hacker_news",
      topic: "ai",
    });
    expect(parseSituationalIntent("What's in the news?")).toBeNull();
    expect(parseSituationalIntent("What's the weather?")).toBeNull();
  });
});
