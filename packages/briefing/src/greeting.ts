import { timeOfDayGreeting } from "./day.js";

export type GreetingLlm = (messages: Array<{ role: "system" | "user"; content: string }>) => Promise<string>;

const SYSTEM_PROMPT =
  "You are Alfred, a professional but warm AI butler. Generate a brief, personalized greeting for a morning briefing. Keep it to 1-2 sentences. Be warm but not overly effusive.";

export function postProcessGreeting(raw: string, fallback: string): string {
  const first = raw
    .split(/\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return fallback;
  return first.replace(/[.!?]+$/g, "").trim() || fallback;
}

export async function buildGreeting(opts: {
  now: Date;
  timezone: string;
  userName: string;
  dateLabel: string;
  weatherSummary?: string | null;
  llmGreeting: boolean;
  llm?: GreetingLlm | null;
}): Promise<string> {
  const fallback = timeOfDayGreeting(opts.now, opts.timezone);
  if (!opts.llmGreeting || !opts.llm) return fallback;

  try {
    const weatherBit = opts.weatherSummary ? ` Weather: ${opts.weatherSummary}` : "";
    const user = `Generate a morning greeting for ${opts.userName}. Today is ${opts.dateLabel}.${weatherBit}`;
    const raw = await opts.llm([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ]);
    return postProcessGreeting(raw, fallback);
  } catch {
    return fallback;
  }
}
