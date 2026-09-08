import { loadBriefingConfig, type BriefingConfig } from "./config.js";
import { fetchWeather, formatWeatherSpeech } from "./weather.js";

export interface WeatherForecastLookupOpts {
  /** Free-text place or zip; defaults to configured home location. */
  location?: string | null;
  /** How many forecast days to include (1–7). Default 3. */
  days?: number | null;
}

/**
 * Conversational weather lookup for the voice `get_weather_forecast` tool.
 * Reuses the same Open-Meteo path as the daily briefing.
 */
export async function lookupWeatherForecastSpeech(
  opts: WeatherForecastLookupOpts = {},
  configOverrides: Partial<BriefingConfig> = {},
): Promise<string> {
  const config = loadBriefingConfig(configOverrides);
  const daysRaw = opts.days == null ? 3 : Number(opts.days);
  const days = Number.isFinite(daysRaw) ? Math.min(7, Math.max(1, Math.round(daysRaw))) : 3;

  const locationOverride = opts.location?.trim() || null;
  const useHomeCoords =
    !locationOverride && config.latitude != null && config.longitude != null;

  const location =
    locationOverride ||
    config.zip ||
    (useHomeCoords ? "home" : null);

  if (!location) {
    return "I don't have a home location configured for weather. Set BRIEFING_ZIP or BRIEFING_LAT/LON, or tell me a city or zip code.";
  }

  const weather = await fetchWeather(
    location,
    false,
    useHomeCoords
      ? {
          lat: config.latitude!,
          lon: config.longitude!,
          timezone: config.timezone,
          name: config.zip ?? "Home",
        }
      : null,
  );

  if (!weather) {
    return locationOverride
      ? `I couldn't get a forecast for ${locationOverride} right now.`
      : "I couldn't get the weather forecast right now.";
  }

  weather.daily = weather.daily.slice(0, days);
  const spoken = formatWeatherSpeech(weather);
  // Name the place when looking up somewhere other than the default home point.
  if (locationOverride) {
    return `For ${weather.location}: ${spoken}`;
  }
  return spoken;
}
