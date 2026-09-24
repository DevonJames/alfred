import { fetchJson } from "./feed-http.js";

export interface EarthquakeQuery {
  /** significant = USGS significant feed. notable = magnitude 4.5 (or 2.5 when recent). */
  scope?: "significant" | "notable";
  /** Last hour instead of the last day. */
  recent?: boolean;
  /** Substring or region name matched against the USGS place string. */
  place?: string;
}

interface Quake {
  mag: number;
  place: string;
  time: number;
  tsunami: boolean;
}

const FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/";

const US_STATE_ABBR: Record<string, string> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
  "district of columbia": "dc",
};

export function earthquakeFeedName(query: EarthquakeQuery): string {
  const significant = query.scope === "significant";
  const recent = query.recent === true;
  if (significant && recent) return "significant_hour.geojson";
  if (significant) return "significant_day.geojson";
  if (recent) return "2.5_hour.geojson";
  return "4.5_day.geojson";
}

function windowPhrase(query: EarthquakeQuery): string {
  const significant = query.scope === "significant";
  const recent = query.recent === true;
  if (significant && recent) return "in the last hour";
  if (significant) return "in the last day";
  if (recent) return "of magnitude 2.5 or larger in the last hour";
  return "of magnitude 4.5 or larger in the last day";
}

export function placeMatchesQuake(usgsPlace: string, query: string): boolean {
  const hay = usgsPlace.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (hay.includes(needle)) return true;
  const abbr = US_STATE_ABBR[needle];
  if (abbr && new RegExp(`\\b${abbr}\\b`, "i").test(usgsPlace)) return true;
  if (needle === "dc" || needle === "d.c." || needle === "washington dc") {
    return /\bdc\b/i.test(usgsPlace) || hay.includes("district of columbia");
  }
  return false;
}

export function speakQuakeAgo(timeMs: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timeMs) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? "about an hour ago" : `about ${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "about a day ago" : `about ${days} days ago`;
}

function speakMagnitude(mag: number): string {
  const rounded = Math.round(mag * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `magnitude ${text}`;
}

export function formatEarthquakeSpeech(
  quakes: Quake[],
  query: EarthquakeQuery,
  now = Date.now(),
): string {
  const window = windowPhrase(query);
  const where = query.place?.trim();
  if (!quakes.length) {
    return where
      ? `No earthquakes ${window} near ${where}.`
      : `No earthquakes ${window}.`;
  }
  const lines = quakes.slice(0, 2).map((quake) => {
    const tsunami = quake.tsunami ? " A tsunami flag is set on that event." : "";
    return `A ${speakMagnitude(quake.mag)} earthquake ${quake.place} ${speakQuakeAgo(quake.time, now)}.${tsunami}`;
  });
  if (quakes.length === 1) return lines[0]!;
  return `${lines[0]} Also, ${lines[1]!.charAt(0).toLowerCase()}${lines[1]!.slice(1)}`;
}

function parseQuakes(payload: unknown): Quake[] {
  const features = (payload as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const quakes: Quake[] = [];
  for (const feature of features) {
    const props = (feature as { properties?: Record<string, unknown> }).properties;
    if (!props || props.type !== "earthquake") continue;
    const mag = typeof props.mag === "number" ? props.mag : Number(props.mag);
    const place = typeof props.place === "string" ? props.place.trim() : "";
    const time = typeof props.time === "number" ? props.time : Number(props.time);
    if (!Number.isFinite(mag) || !place || !Number.isFinite(time)) continue;
    quakes.push({
      mag,
      place,
      time,
      tsunami: props.tsunami === 1,
    });
  }
  quakes.sort((a, b) => b.time - a.time);
  return quakes;
}

export async function lookupEarthquakes(query: EarthquakeQuery = {}): Promise<string> {
  const url = `${FEED_BASE}${earthquakeFeedName(query)}`;
  const payload = await fetchJson(url);
  if (!payload) return "I couldn't reach the earthquake feed just now.";
  let quakes = parseQuakes(payload);
  const place = query.place?.trim();
  if (place) quakes = quakes.filter((quake) => placeMatchesQuake(quake.place, place));
  return formatEarthquakeSpeech(quakes, { ...query, place });
}
