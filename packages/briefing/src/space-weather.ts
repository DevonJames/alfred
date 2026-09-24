import { fetchJson } from "./feed-http.js";

interface ScaleSlot {
  scale: number | null;
  text: string | null;
}

interface ScaleDay {
  geomagnetic: ScaleSlot;
  radio: ScaleSlot;
}

function readSlot(raw: unknown): ScaleSlot {
  const slot = raw as { Scale?: unknown; Text?: unknown } | null;
  if (!slot || typeof slot !== "object") return { scale: null, text: null };
  const scaleRaw = slot.Scale;
  const scale =
    scaleRaw == null || scaleRaw === ""
      ? null
      : Number(scaleRaw);
  return {
    scale: scale != null && Number.isFinite(scale) ? scale : null,
    text: typeof slot.Text === "string" && slot.Text.trim() ? slot.Text.trim() : null,
  };
}

function readDay(raw: unknown): ScaleDay | null {
  if (!raw || typeof raw !== "object") return null;
  const day = raw as { G?: unknown; R?: unknown };
  return { geomagnetic: readSlot(day.G), radio: readSlot(day.R) };
}

function scalePhrase(slot: ScaleSlot, fallback: string): string | null {
  if (slot.scale == null || slot.scale <= 0) return null;
  const word = slot.text && slot.text.toLowerCase() !== "none" ? slot.text.toLowerCase() : fallback;
  return `G${slot.scale} ${word}`.replace(/\s+/g, " ").trim();
}

export function formatSpaceWeatherSpeech(payload: unknown): string {
  const doc = payload as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return "I couldn't read the space weather scales just now.";
  const current = readDay(doc["0"]);
  if (!current) return "I couldn't read the space weather scales just now.";

  const forecast = [readDay(doc["1"]), readDay(doc["2"]), readDay(doc["3"])].filter(
    (day): day is ScaleDay => day != null,
  );
  const currentG = scalePhrase(current.geomagnetic, "geomagnetic storm");
  const forecastG = forecast
    .map((day) => scalePhrase(day.geomagnetic, "geomagnetic storm"))
    .find((phrase) => phrase != null);

  const parts: string[] = [];
  if (currentG) {
    parts.push(`A ${currentG} geomagnetic storm is in effect.`);
  } else if (forecastG) {
    parts.push(`No geomagnetic storm is in effect right now. A ${forecastG} storm is in the forecast.`);
  } else {
    parts.push("No geomagnetic storm is in effect.");
  }

  const gLevel = current.geomagnetic.scale ?? 0;
  const forecastLevel = Math.max(
    0,
    ...forecast.map((day) => day.geomagnetic.scale ?? 0),
  );
  const peak = Math.max(gLevel, forecastLevel);
  if (peak >= 3) {
    parts.push("Aurora may be visible farther south than usual.");
  } else if (peak >= 1) {
    parts.push("Aurora is more likely at high latitudes.");
  }

  const radio = current.radio.scale ?? 0;
  if (radio > 0) {
    const word = current.radio.text ? current.radio.text.toLowerCase() : "active";
    parts.push(`A radio blackout scale of R${radio}, ${word}, is also current.`);
  }

  return parts.join(" ");
}

export async function lookupSpaceWeather(): Promise<string> {
  const payload = await fetchJson("https://services.swpc.noaa.gov/products/noaa-scales.json");
  if (!payload) return "I couldn't reach the space weather service just now.";
  return formatSpaceWeatherSpeech(payload);
}
