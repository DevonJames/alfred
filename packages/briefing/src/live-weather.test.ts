import { describe, expect, it, vi } from "vitest";
import { lookupLiveWeatherForecast } from "./live-weather.js";

describe("lookupLiveWeatherForecast", () => {
  it("returns a spoken forecast for home coords", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("api.open-meteo.com")) {
          return new Response(
            JSON.stringify({
              latitude: 35.26,
              longitude: -120.65,
              timezone: "America/Los_Angeles",
              current: {
                temperature_2m: 70,
                relative_humidity_2m: 40,
                apparent_temperature: 68,
                weather_code: 0,
                wind_speed_10m: 5,
                wind_direction_10m: 180,
                is_day: 1,
              },
              daily: {
                time: ["2026-09-06", "2026-09-07", "2026-09-08"],
                temperature_2m_max: [78, 80, 76],
                temperature_2m_min: [55, 56, 54],
                weather_code: [0, 2, 3],
                precipitation_probability_max: [0, 10, 20],
                precipitation_sum: [0, 0, 0],
              },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    try {
      const speech = await lookupLiveWeatherForecast(
        { days: 2 },
        {
          zip: "93401",
          latitude: 35.2635,
          longitude: -120.6509,
          timezone: "America/Los_Angeles",
          llmGreeting: false,
        },
      );
      expect(speech).toMatch(/Currently 70 degrees/);
      expect(speech).toMatch(/Today,/);
      expect(speech).toMatch(/Tomorrow,/);
      expect(speech).not.toMatch(/day after tomorrow/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("explains when no location is configured", async () => {
    const speech = await lookupLiveWeatherForecast(
      {},
      { zip: null, latitude: null, longitude: null, llmGreeting: false },
    );
    expect(speech).toMatch(/BRIEFING_ZIP|location configured/i);
  });
});
