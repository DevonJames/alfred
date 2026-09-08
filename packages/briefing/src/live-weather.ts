import { loadBriefingConfig, type BriefingConfig } from "./config.js";
import { fetchWeather, formatWeatherSpeech } from "./weather.js";

export interface LiveWeatherLookupOpts {
  /** Free-text place or zip; defaults to briefing home location. */
  location?: string | null;
  /** How many forecast days to include in speech (1–5). Default 3. */
  days?: number | null;
}

/**
 * Live Open-Meteo forecast for conversational asks (same stack as daily briefing).
 */
export async function lookupLiveWeatherForecast(
  opts: LiveWeatherLookupOpts = {},
  configOverrides: Partial<BriefingConfig> = {},
): Promise<string> {
  const config = loadBriefingConfig(configOverrides);
  const requested = opts.location?.trim() || null;
  const days = Math.min(5, Math.max(1, Math.floor(opts.days ?? 3)));

  const useHomeCoords =
    !requested && config.latitude != null && config.longitude != null;
  const locationLabel = requested || config.zip || "home";

  if (!requested && !config.zip && !useHomeCoords) {
    return "I don't have a home location configured for weather yet. Set BRIEFING_ZIP or BRIEFING_LAT/LON, or tell me a city or zip to check.";
  }

  const weather = await fetchWeather(
    locationLabel,
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
    return requested
      ? `I couldn't get a forecast for ${requested} right now.`
      : "I couldn't get the weather forecast right now.";
  }

  const trimmed = {
    ...weather,
    daily: weather.daily.slice(0, days),
  };
  return formatWeatherSpeech(trimmed);
}
