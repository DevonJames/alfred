import { timeOfDayGreeting } from "./day.js";

export type GreetingLlm = (messages: Array<{ role: "system" | "user"; content: string }>) => Promise<string>;

const SYSTEM_PROMPT = `You are Alfred, a professional but warm AI butler.
Return ONLY a short spoken salutation for a daily briefing (about 3 to 8 words).
Examples: "Good evening", "Good evening, Devon", "Good afternoon".
Do NOT mention the date, day of week, weather, temperature, humidity, news, launches, markets, or any other briefing content.
Do NOT write more than one short sentence. No preamble.`;

/**
 * Keep only a short salutation. Long LLM intros that restate date/weather are rejected
 * so formatBriefingForSpeech can own those sections without duplication.
 */
export function postProcessGreeting(raw: string, fallback: string): string {
  const firstLine = raw
    .split(/\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return fallback;

  const firstSentence = (firstLine.match(/^[\s\S]*?[.!?]/) ?? [firstLine])[0]!;
  let cleaned = firstSentence.replace(/[.!?]+$/g, "").replace(/,?\s*sir$/i, "").trim();
  if (!cleaned) return fallback;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 10) return fallback;

  // Reject content that belongs in later speech sections
  if (
    /\b(degrees?|fahrenheit|celsius|weather|humid|wind|forecast|currently|today is|headline|bitcoin|launch|remind)\b/i.test(
      cleaned,
    )
  ) {
    return fallback;
  }

  // Reject wrong time-of-day vs fallback (e.g. "Good morning" at 10pm)
  const lower = cleaned.toLowerCase();
  if (fallback === "Good evening" && /\bmorning\b/.test(lower)) return fallback;
  if (fallback === "Good morning" && /\b(evening|afternoon)\b/.test(lower)) return fallback;
  if (fallback === "Good afternoon" && /\b(morning|evening)\b/.test(lower)) return fallback;

  // Prefer salutation that starts with the correct time-of-day phrase
  if (!lower.startsWith(fallback.toLowerCase())) {
    // Allow "Good evening, Devon" style only when the time-of-day word matches
    const todWord = fallback.replace(/^Good\s+/i, "").toLowerCase();
    if (!lower.includes(todWord)) return fallback;
  }

  return cleaned;
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
    // Do not pass weather into the prompt — speech formatter covers weather separately.
    const user =
      `The correct time-of-day salutation is "${fallback}". ` +
      `Optionally address ${opts.userName}. ` +
      `Return only that short salutation — nothing else.`;
    const raw = await opts.llm([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ]);
    return postProcessGreeting(raw, fallback);
  } catch {
    return fallback;
  }
}
