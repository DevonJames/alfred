import { loadBriefingConfig, type BriefingConfig } from "./config.js";
import { fetchJson } from "./feed-http.js";
import { speakClockTime, speakWeekday } from "./speech.js";
import { geocodePlace } from "./weather.js";

export interface WeatherAlertQuery {
  /** City, region, or zip. Omit to use the briefing home point. */
  location?: string;
}

interface Alert {
  event: string;
  severity: string;
  area: string;
  ends?: string;
}

const SEVERITY_RANK: Record<string, number> = {
  Extreme: 0,
  Severe: 1,
  Moderate: 2,
  Minor: 3,
  Unknown: 4,
};

function alertRank(alert: Alert): number {
  const severity = SEVERITY_RANK[alert.severity] ?? 5;
  const kind = /warning/i.test(alert.event) ? 0 : /watch/i.test(alert.event) ? 1 : 2;
  return severity * 10 + kind;
}

function isSevere(alert: Alert): boolean {
  return (
    alert.severity === "Extreme" ||
    alert.severity === "Severe" ||
    /warning/i.test(alert.event)
  );
}

function speakUntil(ends: string | undefined): string {
  if (!ends) return "";
  const when = new Date(ends);
  if (Number.isNaN(when.getTime())) return "";
  return ` until ${speakWeekday(when)} at ${speakClockTime(when)}`;
}

export function formatWeatherAlertSpeech(alerts: Alert[], placeLabel: string): string {
  const where = placeLabel.trim() || "home";
  if (!alerts.length) return `No active weather alerts near ${where}.`;
  const ranked = [...alerts].sort((a, b) => alertRank(a) - alertRank(b));
  const severe = ranked.filter(isSevere);
  const spoken = (severe.length ? severe : ranked).slice(0, 2);
  const sentences = spoken.map(
    (alert) => `${alert.event} for ${alert.area || where}${speakUntil(alert.ends)}.`,
  );
  const lead = severe.length
    ? sentences.join(" ")
    : `No severe warnings near ${where}. ${sentences.join(" ")}`;
  if (ranked.length > spoken.length) {
    return `${lead} ${ranked.length} alerts are active in total.`;
  }
  return lead;
}

function parseAlerts(payload: unknown): Alert[] {
  const features = (payload as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const alerts: Alert[] = [];
  for (const feature of features) {
    const props = (feature as { properties?: Record<string, unknown> }).properties;
    if (!props) continue;
    const event = typeof props.event === "string" ? props.event.trim() : "";
    if (!event) continue;
    alerts.push({
      event,
      severity: typeof props.severity === "string" ? props.severity : "Unknown",
      area: typeof props.areaDesc === "string" ? props.areaDesc.trim() : "",
      ends: typeof props.ends === "string" ? props.ends : undefined,
    });
  }
  return alerts;
}

async function resolvePoint(
  location: string | undefined,
  config: BriefingConfig,
): Promise<{ lat: number; lon: number; label: string } | { error: string }> {
  const requested = location?.trim();
  if (!requested) {
    if (config.latitude != null && config.longitude != null) {
      return {
        lat: config.latitude,
        lon: config.longitude,
        label: config.zip ?? "home",
      };
    }
    if (config.zip) {
      const geo = await geocodePlace(config.zip);
      if (!geo) return { error: "I couldn't look up the home zip for weather alerts." };
      return { lat: geo.lat, lon: geo.lon, label: geo.name };
    }
    return {
      error:
        "I don't have a home location configured for weather alerts. Set BRIEFING_ZIP or BRIEFING_LAT/LON, or name a city.",
    };
  }
  const geo = await geocodePlace(requested);
  if (!geo) return { error: `I couldn't find ${requested} for weather alerts.` };
  return { lat: geo.lat, lon: geo.lon, label: geo.name };
}

export async function lookupWeatherAlerts(
  query: WeatherAlertQuery = {},
  configOverrides: Partial<BriefingConfig> = {},
): Promise<string> {
  const config = loadBriefingConfig(configOverrides);
  const point = await resolvePoint(query.location, config);
  if ("error" in point) return point.error;
  const url =
    `https://api.weather.gov/alerts/active?point=${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
  const payload = await fetchJson(url, { accept: "application/geo+json" });
  if (!payload) return "I couldn't reach the weather alert service just now.";
  return formatWeatherAlertSpeech(parseAlerts(payload), point.label);
}
