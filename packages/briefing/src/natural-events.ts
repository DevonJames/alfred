import { fetchJson } from "./feed-http.js";

export type NaturalEventKind = "wildfires" | "volcanoes" | "both";

export interface NaturalEventQuery {
  kind?: NaturalEventKind;
}

interface EarthEvent {
  title: string;
  category: "wildfires" | "volcanoes";
  date: string;
  acres?: number;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function speakAcres(acres: number | undefined): string {
  if (acres == null || !Number.isFinite(acres) || acres <= 0) return "";
  const rounded = Math.round(acres);
  if (rounded >= 1000) {
    const thousands = Math.round(rounded / 100) / 10;
    return `, about ${thousands} thousand acres`;
  }
  return `, about ${rounded} acres`;
}

function describe(event: EarthEvent): string {
  return `${event.title}${event.category === "wildfires" ? speakAcres(event.acres) : ""}`;
}

export function formatNaturalEventSpeech(events: EarthEvent[], kind: NaturalEventKind): string {
  const fires = events.filter((event) => event.category === "wildfires");
  const volcanoes = events.filter((event) => event.category === "volcanoes");
  const sentences: string[] = [];

  if (kind !== "volcanoes") {
    if (!fires.length) {
      sentences.push("No open wildfires in the NASA event feed.");
    } else {
      const sample = fires.slice(0, 2).map(describe);
      const count = fires.length === 1 ? "One open wildfire" : `${fires.length} open wildfires`;
      sentences.push(`${count}: ${joinAnd(sample)}.`);
    }
  }

  if (kind !== "wildfires") {
    if (!volcanoes.length) {
      sentences.push("No open volcano events in the NASA event feed.");
    } else {
      const sample = volcanoes.slice(0, 2).map((event) => event.title);
      const count = volcanoes.length === 1 ? "One open volcano event" : `${volcanoes.length} open volcano events`;
      sentences.push(`${count}: ${joinAnd(sample)}.`);
    }
  }

  return sentences.join(" ");
}

function parseEvents(payload: unknown): EarthEvent[] {
  const events = (payload as { events?: unknown[] } | null)?.events;
  if (!Array.isArray(events)) return [];
  const parsed: EarthEvent[] = [];
  for (const raw of events) {
    const event = raw as {
      title?: unknown;
      categories?: Array<{ id?: string }>;
      geometry?: Array<{ date?: string; magnitudeValue?: number; magnitudeUnit?: string }>;
    };
    const categoryId = event.categories?.find((category) =>
      category.id === "wildfires" || category.id === "volcanoes",
    )?.id;
    if (categoryId !== "wildfires" && categoryId !== "volcanoes") continue;
    const title = typeof event.title === "string" ? event.title.trim() : "";
    if (!title) continue;
    const geometry = Array.isArray(event.geometry) ? event.geometry : [];
    const latest = geometry[geometry.length - 1];
    const acres =
      categoryId === "wildfires" &&
      latest &&
      typeof latest.magnitudeValue === "number" &&
      /acre/i.test(latest.magnitudeUnit ?? "")
        ? latest.magnitudeValue
        : undefined;
    parsed.push({
      title,
      category: categoryId,
      date: latest?.date ?? "",
      acres,
    });
  }
  parsed.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return parsed;
}

export async function lookupNaturalEvents(query: NaturalEventQuery = {}): Promise<string> {
  const kind = query.kind ?? "both";
  const payload = await fetchJson(
    "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=40",
  );
  if (!payload) return "I couldn't reach NASA's natural event feed just now.";
  return formatNaturalEventSpeech(parseEvents(payload), kind);
}
