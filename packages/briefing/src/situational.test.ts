import { describe, expect, it, vi } from "vitest";
import { formatEarthquakeSpeech, lookupEarthquakes, placeMatchesQuake } from "./earthquakes.js";
import { formatExchangeChangeSpeech, formatExchangeSpeech, lookupExchangeRate } from "./exchange-rate.js";
import { formatHackerNewsSpeech, lookupHackerNews } from "./hacker-news.js";
import { formatNaturalEventSpeech, lookupNaturalEvents } from "./natural-events.js";
import { formatSpaceWeatherSpeech, lookupSpaceWeather } from "./space-weather.js";
import { formatWeatherAlertSpeech, lookupWeatherAlerts } from "./weather-alerts.js";

describe("earthquake speech", () => {
  it("speaks magnitude, place, and age", () => {
    const now = Date.parse("2026-09-24T02:00:00Z");
    const speech = formatEarthquakeSpeech(
      [
        {
          mag: 6.2,
          place: "near the east coast of Honshu, Japan",
          time: now - 38 * 60_000,
          tsunami: false,
        },
      ],
      { scope: "significant" },
      now,
    );
    expect(speech).toMatch(/magnitude 6\.2/);
    expect(speech).toMatch(/Honshu, Japan/);
    expect(speech).toMatch(/38 minutes ago/);
  });

  it("matches California against a USGS CA place", () => {
    expect(placeMatchesQuake("10km NW of Ridgecrest, CA", "California")).toBe(true);
  });

  it("uses the significant-day feed", async () => {
    let requested = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requested = String(input);
        return new Response(JSON.stringify({ features: [] }), { status: 200 });
      }),
    );
    try {
      const speech = await lookupEarthquakes({ scope: "significant" });
      expect(requested).toContain("significant_day.geojson");
      expect(speech).toMatch(/No earthquakes in the last day/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("weather alert speech", () => {
  it("says when only an advisory is active", () => {
    const speech = formatWeatherAlertSpeech(
      [
        {
          event: "Coastal Flood Advisory",
          severity: "Minor",
          area: "District of Columbia",
          ends: "2026-09-25T13:00:00Z",
        },
      ],
      "home",
    );
    expect(speech).toMatch(/No severe warnings/);
    expect(speech).toMatch(/Coastal Flood Advisory/);
    expect(speech).toMatch(/District of Columbia/);
  });

  it("asks for a home location when none is configured", async () => {
    const speech = await lookupWeatherAlerts({}, { zip: null, latitude: null, longitude: null });
    expect(speech).toMatch(/BRIEFING_ZIP|home location/i);
  });
});

describe("space weather speech", () => {
  it("speaks a current geomagnetic scale and an aurora note", () => {
    const speech = formatSpaceWeatherSpeech({
      "0": {
        G: { Scale: "3", Text: "strong" },
        R: { Scale: "0", Text: "none" },
      },
      "1": { G: { Scale: "1", Text: "minor" }, R: { Scale: null, Text: null } },
    });
    expect(speech).toMatch(/G3 strong geomagnetic storm is in effect/);
    expect(speech).toMatch(/farther south/);
  });

  it("says when the scales are quiet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            "0": { G: { Scale: "0", Text: "none" }, R: { Scale: "0", Text: "none" } },
          }),
          { status: 200 },
        ),
      ),
    );
    try {
      const speech = await lookupSpaceWeather();
      expect(speech).toMatch(/No geomagnetic storm is in effect/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("natural event speech", () => {
  it("names open wildfires and acreage", () => {
    const speech = formatNaturalEventSpeech(
      [
        {
          title: "Wildfire Round Prairie, Louisiana",
          category: "wildfires",
          date: "2026-09-20T17:32:00Z",
          acres: 739,
        },
      ],
      "wildfires",
    );
    expect(speech).toMatch(/One open wildfire/);
    expect(speech).toMatch(/739 acres/);
  });

  it("filters the NASA feed to volcanoes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            events: [
              {
                title: "Kilauea",
                categories: [{ id: "volcanoes" }],
                geometry: [{ date: "2026-09-23T00:00:00Z" }],
              },
              {
                title: "Some Fire",
                categories: [{ id: "wildfires" }],
                geometry: [{ date: "2026-09-23T00:00:00Z", magnitudeValue: 10, magnitudeUnit: "acres" }],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    try {
      const speech = await lookupNaturalEvents({ kind: "volcanoes" });
      expect(speech).toMatch(/Kilauea/);
      expect(speech).not.toMatch(/Some Fire/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("exchange speech", () => {
  it("speaks a converted amount", () => {
    expect(
      formatExchangeSpeech({
        amount: 500,
        from: "USD",
        to: "EUR",
        converted: 460.12,
        date: "2026-09-23",
      }),
    ).toMatch(/500 dollars is about 460 euros/);
  });

  it("speaks a week-over-week move", () => {
    expect(
      formatExchangeChangeSpeech({ from: "USD", to: "JPY", latest: 158, previous: 155 }),
    ).toMatch(/158 yen/);
    expect(
      formatExchangeChangeSpeech({ from: "USD", to: "JPY", latest: 158, previous: 155 }),
    ).toMatch(/percent more/);
  });

  it("calls Frankfurter for a conversion", async () => {
    let requested = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requested = String(input);
        return new Response(
          JSON.stringify({ amount: 500, base: "USD", date: "2026-09-23", rates: { EUR: 460 } }),
          { status: 200 },
        );
      }),
    );
    try {
      const speech = await lookupExchangeRate({ amount: 500, from: "USD", to: "EUR" });
      expect(requested).toContain("frankfurter.dev");
      expect(speech).toMatch(/500 dollars is about 460 euros/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("hacker news speech", () => {
  it("lists three titles", () => {
    const speech = formatHackerNewsSpeech(
      [
        { title: "Meta VR Glasses", score: 200 },
        { title: "A new database", score: 100 },
        { title: "Rust in the kernel", score: 80 },
      ],
      "general",
    );
    expect(speech).toMatch(/Meta VR Glasses, A new database, and Rust in the kernel/);
  });

  it("filters titles for AI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("topstories.json")) {
          return new Response(JSON.stringify([1, 2]), { status: 200 });
        }
        if (url.endsWith("/1.json")) {
          return new Response(
            JSON.stringify({ type: "story", title: "Meta VR Glasses", score: 10 }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ type: "story", title: "OpenAI ships a new model", score: 50 }),
          { status: 200 },
        );
      }),
    );
    try {
      const speech = await lookupHackerNews({ topic: "ai" });
      expect(speech).toMatch(/OpenAI ships a new model/);
      expect(speech).not.toMatch(/Meta VR Glasses/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
