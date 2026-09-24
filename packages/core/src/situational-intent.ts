export type SituationalIntent =
  | {
      tool: "earthquakes";
      scope?: "significant" | "notable";
      recent?: boolean;
      place?: string;
    }
  | { tool: "weather_alerts"; location?: string }
  | { tool: "space_weather" }
  | { tool: "natural_events"; kind?: "wildfires" | "volcanoes" | "both" }
  | {
      tool: "exchange_rate";
      amount?: number;
      from: string;
      to: string;
      change?: boolean;
    }
  | { tool: "hacker_news"; topic?: "general" | "ai" };

const TALKING_ABOUT_TOOL =
  /\b(get[_\s-]*(earthquakes|weather[_\s-]*alerts|space[_\s-]*weather|natural[_\s-]*events|exchange[_\s-]*rate|hacker[_\s-]*news))\b/i;

const CRYPTO =
  /\b(bitcoin|btc|ethereum|eth\b|solana|\bsol\b|crypto(?:currency)?|dogecoin)\b/i;

const HOME =
  /\b(right here|out here|locally|at home|my (?:area|place|house|city|zip)|this (?:area|city|place)|around here|near me|near home)\b/i;

const CURRENCY_RE =
  /\b(australian\s+dollars?|canadian\s+dollars?|euros?|yen|pounds?|sterling|quid|swiss\s+francs?|francs?|yuan|renminbi|rupees?|pesos?|won|dollars?|bucks|usd)\b|\$/gi;

/**
 * True when the utterance should short-circuit to a round-1 situational lookup.
 */
export function looksLikeSituationalTask(text: string): boolean {
  return parseSituationalIntent(text) != null;
}

/**
 * Deterministic ask for earthquakes, weather alerts, space weather, NASA
 * natural events, exchange rates, or Hacker News.
 * Checked before the weather-forecast and news parsers.
 */
export function parseSituationalIntent(text: string): SituationalIntent | null {
  const raw = text.trim();
  if (!raw || TALKING_ABOUT_TOOL.test(raw)) return null;

  const earthquakes = parseEarthquakes(raw);
  if (earthquakes) return earthquakes;
  const space = parseSpaceWeather(raw);
  if (space) return space;
  const alerts = parseWeatherAlerts(raw);
  if (alerts) return alerts;
  const natural = parseNaturalEvents(raw);
  if (natural) return natural;
  const exchange = parseExchange(raw);
  if (exchange) return exchange;
  const hackerNews = parseHackerNews(raw);
  if (hackerNews) return hackerNews;
  return null;
}

function parseEarthquakes(text: string): SituationalIntent | null {
  if (!/\b(earthquakes?|quakes?|seismic|aftershocks?)\b/i.test(text) && !/\bwhat\s+(?:just\s+)?shook\b/i.test(text)) {
    return null;
  }
  const significant = /\bsignificant\b/i.test(text);
  const recent = /\b(just|this hour|past hour|last hour|right now)\b/i.test(text);
  const place = extractPlace(text);
  return {
    tool: "earthquakes",
    scope: significant ? "significant" : "notable",
    recent,
    ...(place ? { place } : {}),
  };
}

function parseSpaceWeather(text: string): SituationalIntent | null {
  if (
    /\b(geomagnetic|space\s+weather|aurora|northern\s+lights|solar\s+(?:storm|flare|radiation)|k-?p?\s*index)\b/i.test(
      text,
    )
  ) {
    return { tool: "space_weather" };
  }
  return null;
}

function parseWeatherAlerts(text: string): SituationalIntent | null {
  const hazard =
    /\b(severe\s+weather|weather\s+(?:warnings?|alerts?|advisories|advisory|watches|watch)|tornado(?:\s+(?:warning|watch))?|thunderstorm\s+warning|flash\s+flood|flood\s+(?:warning|watch|advisory)|winter\s+storm|heat\s+advisory|hurricane\s+(?:warning|watch)|coastal\s+flood)\b/i.test(
      text,
    );
  const generic =
    /\b(warnings?|alerts?|advisories)\b/i.test(text) &&
    /\b(active|today|near|around|home|here)\b/i.test(text);
  if (!hazard && !generic) return null;
  const location = extractPlace(text);
  return { tool: "weather_alerts", ...(location ? { location } : {}) };
}

function parseNaturalEvents(text: string): SituationalIntent | null {
  const fires = /\b(wild\s*fires?|forest\s+fires?|brush\s+fires?)\b/i.test(text);
  const volcanoes = /\b(volcanoes?|volcanos?|erupt(?:ing|ion|ions|ed)?)\b/i.test(text);
  if (!fires && !volcanoes) return null;
  const kind = fires && volcanoes ? "both" : fires ? "wildfires" : "volcanoes";
  return { tool: "natural_events", kind };
}

function parseHackerNews(text: string): SituationalIntent | null {
  const named =
    /\bhacker\s*news\b/i.test(text) ||
    /\bhn\b/i.test(text) ||
    /\bwhat\s+are\s+developers\s+talking\s+about\b/i.test(text) ||
    /\bdevelopers?\s+are\s+talking\b/i.test(text) ||
    /\b(?:anything|something)\s+interesting\s+in\s+(?:ai|a\.i\.|machine\s+learning)\b/i.test(text);
  if (!named) return null;
  const topic = /\b(ai|a\.i\.|machine\s+learning|llm|gpt|openai)\b/i.test(text) ? "ai" : "general";
  return { tool: "hacker_news", topic };
}

function parseExchange(text: string): SituationalIntent | null {
  if (CRYPTO.test(text)) return null;
  const codes = currencyCodes(text);
  const foreign = codes.filter((code) => code !== "USD");
  if (!foreign.length && codes.length < 2) return null;
  const ask =
    /\b(what(?:'s| is)|how(?:'s| is| much)|price|rate|worth|exchange|convert(?:ed)?|moved|move|trading|buys?)\b/i.test(
      text,
    ) || /\$\s?\d/.test(text) || /\d/.test(text);
  if (!ask) return null;

  let from: string;
  let to: string;
  if (codes.length >= 2) {
    from = codes[0]!;
    to = codes[1]!;
  } else {
    from = "USD";
    to = foreign[0]!;
  }
  if (from === to) return null;

  const amount = extractAmount(text);
  const change = /\b(moved|move|changed|change)\b/i.test(text);
  return {
    tool: "exchange_rate",
    from,
    to,
    change,
    ...(amount != null && !change ? { amount } : {}),
  };
}

function currencyCodes(text: string): string[] {
  const codes: string[] = [];
  for (const match of text.matchAll(CURRENCY_RE)) {
    const code = codeFor(match[1] ?? match[0] ?? "");
    if (!code) continue;
    if (codes[codes.length - 1] === code) continue;
    codes.push(code);
  }
  return codes;
}

function codeFor(token: string): string | null {
  const t = token.toLowerCase().replace(/\s+/g, " ").trim();
  if (t.startsWith("australian")) return "AUD";
  if (t.startsWith("canadian")) return "CAD";
  if (t === "euro" || t === "euros") return "EUR";
  if (t === "yen") return "JPY";
  if (t === "pound" || t === "pounds" || t === "sterling" || t === "quid") return "GBP";
  if (t.includes("franc")) return "CHF";
  if (t === "yuan" || t === "renminbi") return "CNY";
  if (t === "rupee" || t === "rupees") return "INR";
  if (t === "peso" || t === "pesos") return "MXN";
  if (t === "won") return "KRW";
  if (t === "$" || t === "dollar" || t === "dollars" || t === "bucks" || t === "usd") return "USD";
  return null;
}

function extractAmount(text: string): number | undefined {
  const match = text.match(/\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)/);
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function extractPlace(text: string): string | undefined {
  const zip = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zip?.[1]) return zip[1];
  if (HOME.test(text)) return undefined;

  const named = text.match(
    /\b(?:in|near|around|outside|for|shook|hit)\s+([A-Za-z][A-Za-z0-9.\s'-]{1,48}?)(?:\s*[?.!,]|$)/i,
  );
  if (!named?.[1]) return undefined;
  let place = named[1]
    .replace(
      /\b(right now|today|tonight|tomorrow|this hour|please|thanks|thank you|active)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!,;:]+$/g, "")
    .trim();
  if (!place || HOME.test(place)) return undefined;
  if (/^(the|a|an|my|this|that|here|outside|home)$/i.test(place)) return undefined;
  if (/^(the\s+)?(morning|afternoon|evening|night|week|month|hour|day)$/i.test(place)) return undefined;
  return place;
}
