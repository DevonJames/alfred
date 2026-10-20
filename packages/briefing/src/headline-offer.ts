import type { GreetingLlm } from "./greeting.js";

export const HEADLINE_OFFER_FALLBACK = "Should I get you the latest headlines?";

const SYSTEM_PROMPT =
  "You are Alfred, a professional but warm AI butler. " +
  "Write ONE short spoken question offering to read today's news headlines. " +
  "Vary the wording — do not always use the same phrase. " +
  "Keep it under 16 words. No markdown, no preamble, no second sentence. " +
  "Do not list any headlines. Do not mention weather, markets, or the rest of the briefing.";

/**
 * Spoken closer after the daily brief — invites headlines without reading them yet.
 */
export async function buildHeadlineOffer(opts: {
  llm?: GreetingLlm | null;
  /** How many headlines are ready if they say yes. */
  count?: number;
}): Promise<string> {
  const fallback = HEADLINE_OFFER_FALLBACK;
  if (!opts.llm) return fallback;
  const n = opts.count && opts.count > 0 ? opts.count : undefined;
  try {
    const raw = await opts.llm([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Ask whether I should read the latest headlines now.` +
          (n != null ? ` There are about ${n} ready.` : "") +
          ` Return only the question.`,
      },
    ]);
    return postProcessHeadlineOffer(raw, fallback);
  } catch {
    return fallback;
  }
}

export function postProcessHeadlineOffer(raw: string, fallback = HEADLINE_OFFER_FALLBACK): string {
  const firstLine = raw
    .split(/\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return fallback;

  let cleaned = firstLine
    .replace(/^["'«»]+|["'«»]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Keep a single sentence / question.
  const cut = cleaned.match(/^[\s\S]*?[?]/)?.[0] ?? cleaned.match(/^[\s\S]*?[.!]/)?.[0];
  if (cut) cleaned = cut.trim();
  if (!cleaned) return fallback;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 16) return fallback;
  if (!/\b(headline|headlines|news)\b/i.test(cleaned)) return fallback;
  if (/\b(bitcoin|weather|degrees|agenda|reminder)\b/i.test(cleaned)) return fallback;

  if (!/[?]$/.test(cleaned)) cleaned = `${cleaned.replace(/[.!]+$/g, "")}?`;
  return cleaned;
}
