export type WeatherIntent = {
  /** Named city/place/zip when the user asked about somewhere else. Omit for home. */
  location?: string;
  days?: number;
};

const WEATHER_NOUN =
  /\b(weather|forecast|temperature|temps?\b|humid(?:ity)?|precipitation|rain(?:ing|y)?|snow(?:ing|y)?|sleet|hail|umbrellas?|how(?:'s| is) it looking outside|what(?:'s| is) it like outside)\b/i;

const TALKING_ABOUT_TOOL = /\bget[_\s-]*weather[_\s-]*forecast\b/i;

const HOME_DEIXIS =
  /\b(right here|out here|outside|locally|at home|my (?:area|place|house|city|zip)|this (?:area|city|place)|around here|near me)\b/i;

/**
 * True when the utterance is asking for live weather / forecast (not chitchat about climate history).
 */
export function looksLikeWeatherTask(text: string): boolean {
  return parseWeatherIntent(text) != null;
}

/**
 * Deterministic weather ask from casual speech.
 * Returns null when the utterance is not a weather request.
 * Omits `location` for home / “right here” / bare “what’s the weather”.
 */
export function parseWeatherIntent(text: string): WeatherIntent | null {
  const raw = text.trim();
  if (!raw || TALKING_ABOUT_TOOL.test(raw)) return null;
  if (!WEATHER_NOUN.test(raw)) return null;

  const days = extractDays(raw);
  if (HOME_DEIXIS.test(raw)) {
    return { location: undefined, days };
  }

  const location = extractLocation(raw);
  return { location, days };
}

function extractDays(text: string): number | undefined {
  if (/\b(this\s+weekend|weekend)\b/i.test(text)) return 3;
  if (/\b(next\s+few\s+days|coming\s+days)\b/i.test(text)) return 4;
  const n = text.match(/\b(?:next|for)\s+(\d)\s+days?\b/i);
  if (n) {
    const value = Number(n[1]);
    if (Number.isFinite(value)) return Math.min(5, Math.max(1, value));
  }
  return undefined;
}

function extractLocation(text: string): string | undefined {
  const zip = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip?.[1]) return zip[1];

  const named =
    text.match(
      /\b(?:weather|forecast|temperature|temps?)\s+(?:in|for|near|around)\s+(.+?)(?:\s*[?.!]|$)/i,
    ) ??
    text.match(/\b(?:in|for|near|around)\s+([A-Za-z][A-Za-z0-9\s.'-]{1,48}?)(?:\s*[?.!]|$)/i);
  if (!named?.[1]) return undefined;

  let place = named[1].trim().replace(/[?.!,;:]+$/g, "").trim();
  place = place
    .replace(
      /\b(right now|today|tonight|tomorrow|this (?:morning|afternoon|evening|weekend)|please|thanks|thank you)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!place || HOME_DEIXIS.test(place)) return undefined;
  if (/^(the|a|an|my|this|that|here|outside)$/i.test(place)) return undefined;
  // Avoid false positives like "in the morning".
  if (/^(the\s+)?(morning|afternoon|evening|night|week|month)$/i.test(place)) return undefined;

  return place;
}
