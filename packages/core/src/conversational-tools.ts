import {
  CONTROL_STUDIO_LIGHTS_TOOL,
  GET_CRYPTO_PRICE_TOOL,
  GET_CURRENT_TIME_TOOL,
  GET_EARTHQUAKES_TOOL,
  GET_EXCHANGE_RATE_TOOL,
  GET_HACKER_NEWS_TOOL,
  GET_METALS_PRICE_TOOL,
  GET_NATURAL_EVENTS_TOOL,
  GET_NEWS_HEADLINES_TOOL,
  GET_SPACE_WEATHER_TOOL,
  GET_WEATHER_ALERTS_TOOL,
  GET_WEATHER_FORECAST_TOOL,
  REMEMBER_MEMORY_TOOL,
  SUMMARIZE_NEWS_ARTICLE_TOOL,
  UPDATE_REMINDER_TOOL,
} from "@alfred/contracts";
import type {
  DueReminderSummary,
  MarketsPort,
  NewsPort,
  ReminderPort,
  CurrentTimePort,
  SituationalPort,
  StructuredMemoryPort,
  StudioLightsPort,
  WeatherForecastPort,
} from "./ports.js";
import { resolveReminderMatch } from "./reminder-match.js";

/** Ports the cascade voice session uses beyond plain delegate_task. */
export interface ConversationalPorts {
  reminders?: ReminderPort;
  structuredMemory?: StructuredMemoryPort;
  weather?: WeatherForecastPort;
  news?: NewsPort;
  markets?: MarketsPort;
  /** Spoken local time and date. */
  currentTime?: CurrentTimePort;
  /** Earthquakes, alerts, space weather, natural events, FX, Hacker News. */
  situational?: SituationalPort;
  lights?: StudioLightsPort;
}

type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export function conversationalCapabilities(ports?: ConversationalPorts): string[] {
  const caps = ["delegate_task"];
  if (ports?.reminders) caps.push("update_reminder");
  if (ports?.structuredMemory) caps.push("remember_memory");
  if (ports?.weather) caps.push("get_weather_forecast");
  if (ports?.news) {
    caps.push("get_news_headlines");
    caps.push("summarize_news_article");
  }
  if (ports?.markets) {
    caps.push("get_crypto_price");
    caps.push("get_metals_price");
  }
  if (ports?.currentTime) caps.push("get_current_time");
  if (ports?.situational) {
    caps.push(
      "get_earthquakes",
      "get_weather_alerts",
      "get_space_weather",
      "get_natural_events",
      "get_exchange_rate",
      "get_hacker_news",
    );
  }
  if (ports?.lights) caps.push("control_studio_lights");
  return caps;
}

export function conversationalToolSchemas(ports?: ConversationalPorts): ToolSchema[] {
  const tools: ToolSchema[] = [];
  if (ports?.reminders) tools.push(UPDATE_REMINDER_TOOL as unknown as ToolSchema);
  if (ports?.structuredMemory) tools.push(REMEMBER_MEMORY_TOOL as unknown as ToolSchema);
  if (ports?.weather) tools.push(GET_WEATHER_FORECAST_TOOL as unknown as ToolSchema);
  if (ports?.news) {
    tools.push(GET_NEWS_HEADLINES_TOOL as unknown as ToolSchema);
    tools.push(SUMMARIZE_NEWS_ARTICLE_TOOL as unknown as ToolSchema);
  }
  if (ports?.markets) {
    tools.push(GET_CRYPTO_PRICE_TOOL as unknown as ToolSchema);
    tools.push(GET_METALS_PRICE_TOOL as unknown as ToolSchema);
  }
  if (ports?.currentTime) tools.push(GET_CURRENT_TIME_TOOL as unknown as ToolSchema);
  if (ports?.situational) {
    tools.push(GET_EARTHQUAKES_TOOL as unknown as ToolSchema);
    tools.push(GET_WEATHER_ALERTS_TOOL as unknown as ToolSchema);
    tools.push(GET_SPACE_WEATHER_TOOL as unknown as ToolSchema);
    tools.push(GET_NATURAL_EVENTS_TOOL as unknown as ToolSchema);
    tools.push(GET_EXCHANGE_RATE_TOOL as unknown as ToolSchema);
    tools.push(GET_HACKER_NEWS_TOOL as unknown as ToolSchema);
  }
  if (ports?.lights) tools.push(CONTROL_STUDIO_LIGHTS_TOOL as unknown as ToolSchema);
  return tools;
}

/**
 * Run a cascade voice tool. Weather and lights replace the reply.
 * Reminders and memory keep the model's sentence when it already spoke one.
 */
export async function applyConversationalTool(
  toolName: string | undefined,
  args: Record<string, unknown>,
  ports: ConversationalPorts | undefined,
  dueReminders: DueReminderSummary[],
): Promise<{ mode: "replace" | "ack"; speech: string } | null> {
  if (!toolName || !ports) return null;
  if (toolName === "get_weather_forecast" && ports.weather) {
    return { mode: "replace", speech: await applyWeather(ports.weather, args) };
  }
  if (toolName === "get_news_headlines" && ports.news) {
    const result = await ports.news.getHeadlines();
    return { mode: "replace", speech: result.speech };
  }
  if (toolName === "summarize_news_article" && ports.news) {
    return { mode: "replace", speech: await applyNewsArticle(ports.news, args) };
  }
  if (toolName === "get_crypto_price" && ports.markets) {
    return { mode: "replace", speech: await applyCrypto(ports.markets, args) };
  }
  if (toolName === "get_metals_price" && ports.markets) {
    return { mode: "replace", speech: await applyMetals(ports.markets, args) };
  }
  if (toolName === "get_current_time" && ports.currentTime) {
    return { mode: "replace", speech: await applyCurrentTime(ports.currentTime, args) };
  }
  if (ports.situational && SITUATIONAL_TOOLS.has(toolName)) {
    return { mode: "replace", speech: await applySituational(ports.situational, toolName, args) };
  }
  if (toolName === "control_studio_lights" && ports.lights) {
    return { mode: "replace", speech: await applyLights(ports.lights, args) };
  }
  if (toolName === "remember_memory" && ports.structuredMemory) {
    return { mode: "ack", speech: await applyRemember(ports.structuredMemory, args) };
  }
  if (toolName === "update_reminder" && ports.reminders) {
    return { mode: "ack", speech: await applyReminder(ports.reminders, args, dueReminders) };
  }
  return null;
}

async function applyWeather(port: WeatherForecastPort, args: Record<string, unknown>): Promise<string> {
  const location =
    typeof args.location === "string" && args.location.trim() ? args.location.trim() : undefined;
  const daysRaw = args.days;
  const days =
    typeof daysRaw === "number" && Number.isFinite(daysRaw)
      ? daysRaw
      : typeof daysRaw === "string" && daysRaw.trim() && Number.isFinite(Number(daysRaw))
        ? Number(daysRaw)
        : undefined;
  try {
    return await port.getForecast({ location, days });
  } catch (err) {
    console.error("[session] get_weather_forecast failed:", err);
    return "I couldn't get the weather forecast just now.";
  }
}

async function applyNewsArticle(port: NewsPort, args: Record<string, unknown>): Promise<string> {
  const indexRaw = args.index;
  const index =
    typeof indexRaw === "number" && Number.isFinite(indexRaw)
      ? Math.floor(indexRaw)
      : typeof indexRaw === "string" && indexRaw.trim() && Number.isFinite(Number(indexRaw))
        ? Math.floor(Number(indexRaw))
        : undefined;
  const match = typeof args.match === "string" && args.match.trim() ? args.match.trim() : undefined;
  const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : undefined;
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
  try {
    return await port.summarizeArticle({ index, match, url, title });
  } catch (err) {
    console.error("[session] summarize_news_article failed:", err);
    return "I couldn't summarize that article just now.";
  }
}

const SITUATIONAL_TOOLS = new Set([
  "get_earthquakes",
  "get_weather_alerts",
  "get_space_weather",
  "get_natural_events",
  "get_exchange_rate",
  "get_hacker_news",
]);

async function applySituational(
  port: SituationalPort,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    if (toolName === "get_earthquakes") {
      const scope = args.scope === "significant" ? "significant" : "notable";
      const place = typeof args.place === "string" && args.place.trim() ? args.place.trim() : undefined;
      return await port.earthquakes({
        scope,
        recent: args.recent === true,
        place,
      });
    }
    if (toolName === "get_weather_alerts") {
      const location =
        typeof args.location === "string" && args.location.trim() ? args.location.trim() : undefined;
      return await port.weatherAlerts({ location });
    }
    if (toolName === "get_space_weather") return await port.spaceWeather();
    if (toolName === "get_natural_events") {
      const kind =
        args.kind === "wildfires" || args.kind === "volcanoes" || args.kind === "both"
          ? args.kind
          : "both";
      return await port.naturalEvents({ kind });
    }
    if (toolName === "get_exchange_rate") {
      const from = typeof args.from === "string" ? args.from.trim().toUpperCase() : "";
      const to = typeof args.to === "string" ? args.to.trim().toUpperCase() : "";
      if (!from || !to) return "Tell me which currencies to convert.";
      const amountRaw = args.amount;
      const amount =
        typeof amountRaw === "number" && Number.isFinite(amountRaw)
          ? amountRaw
          : typeof amountRaw === "string" && amountRaw.trim() && Number.isFinite(Number(amountRaw))
            ? Number(amountRaw)
            : undefined;
      return await port.exchangeRate({
        from,
        to,
        amount,
        change: args.change === true,
      });
    }
    if (toolName === "get_hacker_news") {
      const topic = args.topic === "ai" ? "ai" : "general";
      return await port.hackerNews({ topic });
    }
  } catch (err) {
    console.error(`[session] ${toolName} failed:`, err);
  }
  return "I couldn't look that up just now.";
}

async function applyCurrentTime(port: CurrentTimePort, args: Record<string, unknown>): Promise<string> {
  const place = typeof args.place === "string" && args.place.trim() ? args.place.trim() : undefined;
  const kind = args.kind === "date" ? "date" : "time";
  try {
    return await port.getCurrentTime({ place, kind });
  } catch (err) {
    console.error("[session] get_current_time failed:", err);
    return "I couldn't read the clock just now.";
  }
}

async function applyCrypto(port: MarketsPort, args: Record<string, unknown>): Promise<string> {
  const cryptoId =
    typeof args.cryptoId === "string" && args.cryptoId.trim() ? args.cryptoId.trim() : undefined;
  try {
    return await port.getCryptoPrice({ cryptoId });
  } catch (err) {
    console.error("[session] get_crypto_price failed:", err);
    return "I couldn't get that crypto price just now.";
  }
}

async function applyMetals(port: MarketsPort, args: Record<string, unknown>): Promise<string> {
  const raw = typeof args.metalSymbol === "string" ? args.metalSymbol.trim().toLowerCase() : "";
  const metalSymbol = raw === "silver" ? "silver" : raw === "gold" ? "gold" : undefined;
  try {
    return await port.getMetalsPrice({ metalSymbol });
  } catch (err) {
    console.error("[session] get_metals_price failed:", err);
    return "I couldn't get that metals price just now.";
  }
}

async function applyLights(port: StudioLightsPort, args: Record<string, unknown>): Promise<string> {
  const actionRaw = String(args.action ?? "").trim().toLowerCase();
  const allowed = new Set(["on", "off", "brighter", "dimmer", "warmer", "cooler", "set", "status"]);
  if (!allowed.has(actionRaw)) return "I wasn't sure what to do with the lights.";
  const action = actionRaw as
    | "on"
    | "off"
    | "brighter"
    | "dimmer"
    | "warmer"
    | "cooler"
    | "set"
    | "status";
  const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
  const brightnessRaw = args.brightness;
  const brightness =
    typeof brightnessRaw === "number" && Number.isFinite(brightnessRaw)
      ? brightnessRaw
      : typeof brightnessRaw === "string" &&
          brightnessRaw.trim() &&
          Number.isFinite(Number(brightnessRaw))
        ? Number(brightnessRaw)
        : undefined;
  const temperature =
    typeof args.temperature === "number" || typeof args.temperature === "string"
      ? args.temperature
      : undefined;
  try {
    return await port.control({ action, target, brightness, temperature });
  } catch (err) {
    console.error("[session] control_studio_lights failed:", err);
    return "I couldn't reach the lights just now.";
  }
}

async function applyRemember(port: StructuredMemoryPort, args: Record<string, unknown>): Promise<string> {
  const entities = Array.isArray(args.entities)
    ? (args.entities as Array<Record<string, unknown>>)
        .map((entity) => ({
          name: String(entity.name ?? "").trim(),
          entityClass: typeof entity.entityClass === "string" ? entity.entityClass : undefined,
          summary: typeof entity.summary === "string" ? entity.summary : undefined,
          email: typeof entity.email === "string" ? entity.email.trim() : undefined,
          telephone: typeof entity.telephone === "string" ? entity.telephone.trim() : undefined,
          birthDate: typeof entity.birthDate === "string" ? entity.birthDate.trim() : undefined,
        }))
        .filter((entity) => entity.name)
    : [];
  const assertions = Array.isArray(args.assertions)
    ? (args.assertions as Array<Record<string, unknown>>)
        .map((assertion) => ({
          subjectName: String(assertion.subjectName ?? "").trim(),
          predicate: String(assertion.predicate ?? "").trim(),
          objectName: String(assertion.objectName ?? "").trim(),
          text: typeof assertion.text === "string" ? assertion.text : undefined,
        }))
        .filter((assertion) => assertion.subjectName && assertion.predicate && assertion.objectName)
    : [];
  const notes = Array.isArray(args.notes)
    ? (args.notes as unknown[]).map((note) => String(note).trim()).filter(Boolean)
    : [];
  if (!entities.length && !assertions.length && !notes.length) {
    return "I need something concrete to remember.";
  }
  try {
    const result = await port.remember({ entities, assertions, notes });
    const parts: string[] = [];
    if (result.entitiesUpserted) parts.push(`${result.entitiesUpserted} people or things`);
    if (result.assertionsCreated) parts.push(`${result.assertionsCreated} relationships`);
    if (result.notesCreated) parts.push(`${result.notesCreated} notes`);
    return parts.length
      ? `Got it — I've stored that in memory (${parts.join(", ")}).`
      : "Got it — I've noted that.";
  } catch (err) {
    console.error("[session] remember_memory failed:", err);
    return "I couldn't store that memory just now.";
  }
}

async function applyReminder(
  port: ReminderPort,
  args: Record<string, unknown>,
  dueReminders: DueReminderSummary[],
): Promise<string> {
  const actionRaw = String(args.action ?? "").trim().toLowerCase();
  if (actionRaw !== "completed" && actionRaw !== "dismissed" && actionRaw !== "snoozed") {
    return "I need to know whether to complete, dismiss, or snooze that reminder.";
  }
  const due = dueReminders.length > 0 ? dueReminders : await port.listDue();
  const resolved = resolveReminderMatch(due, {
    recordId: typeof args.recordId === "string" ? args.recordId : null,
    match: typeof args.match === "string" ? args.match : null,
  });
  if (resolved.kind === "none") return "I don't see a matching due reminder to update.";
  if (resolved.kind === "ambiguous") {
    const names = resolved.candidates
      .slice(0, 4)
      .map((candidate) => candidate.summary)
      .join("; ");
    return `Which reminder should I update — ${names}?`;
  }
  const target = resolved.reminder;
  const snoozedUntil = typeof args.snoozedUntil === "string" ? args.snoozedUntil.trim() : undefined;
  if (actionRaw === "snoozed" && !snoozedUntil) return "When should I remind you again?";
  try {
    await port.setStatus(target.recordId, actionRaw, snoozedUntil);
    await port.invalidateBriefingDay();
    if (actionRaw === "completed") return `Got it — I've cleared the reminder about ${target.summary}.`;
    if (actionRaw === "dismissed") return `Okay — I won't keep reminding you about ${target.summary}.`;
    return `Okay — I'll snooze the reminder about ${target.summary} until ${snoozedUntil}.`;
  } catch (err) {
    console.error("[session] update_reminder failed:", err);
    return "I couldn't update that reminder just now.";
  }
}
