import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBriefingConfig } from "./config.js";
import { generateBriefing } from "./generate.js";

describe("generateBriefing", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("assembles speech from mocked API responses", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-brief-"));
    dirs.push(dir);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("geocoding-api.open-meteo")) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  name: "Los Angeles",
                  latitude: 34.05,
                  longitude: -118.25,
                  timezone: "America/Los_Angeles",
                  admin1: "California",
                  country: "United States",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("api.open-meteo.com")) {
          return new Response(
            JSON.stringify({
              latitude: 34.05,
              longitude: -118.25,
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
                time: ["2026-08-09", "2026-08-10"],
                temperature_2m_max: [75, 77],
                temperature_2m_min: [60, 61],
                weather_code: [0, 2],
                precipitation_probability_max: [0, 10],
                precipitation_sum: [0, 0],
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes("thespacedevs.com")) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (url.includes("coingecko.com")) {
          return new Response(
            JSON.stringify({ bitcoin: { usd: 100_050, usd_24h_change: 2.5 } }),
            { status: 200 },
          );
        }
        if (url.includes("rss") || url.includes("feeds") || url.includes("hnrss")) {
          return new Response(
            `<rss><channel><title>Feed</title><item><title>Hello World Headline</title></item></channel></rss>`,
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const config = loadBriefingConfig({
      profileId: "test",
      zip: "90210",
      llmGreeting: false,
      stateDir: dir,
      cacheDir: dir,
      newsSources: ["TechCrunch"],
    });

    const payload = await generateBriefing({
      config,
      memory: null,
      refresh: true,
      now: new Date("2026-08-09T18:00:00.000Z"),
    });

    expect(payload.speech).toMatch(/Good (morning|afternoon|evening)/);
    expect(payload.speech.toLowerCase()).toContain("bitcoin");
    expect(payload.speech).not.toMatch(/\[icon:/);
    expect(payload.markdown).toContain("Daily Briefing");
    expect(payload.briefing.weather?.location).toContain("Los Angeles");
  });
});
