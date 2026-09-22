import {
  CONTROL_STUDIO_LIGHTS_TOOL,
  GET_WEATHER_FORECAST_TOOL,
  REMEMBER_MEMORY_TOOL,
  UPDATE_REMINDER_TOOL,
} from "@alfred/contracts";
import type {
  DueReminderSummary,
  ReminderPort,
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
  if (ports?.lights) caps.push("control_studio_lights");
  return caps;
}

export function conversationalToolSchemas(ports?: ConversationalPorts): ToolSchema[] {
  const tools: ToolSchema[] = [];
  if (ports?.reminders) tools.push(UPDATE_REMINDER_TOOL as unknown as ToolSchema);
  if (ports?.structuredMemory) tools.push(REMEMBER_MEMORY_TOOL as unknown as ToolSchema);
  if (ports?.weather) tools.push(GET_WEATHER_FORECAST_TOOL as unknown as ToolSchema);
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
