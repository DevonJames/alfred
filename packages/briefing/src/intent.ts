export type BriefingIntentKind = "explicitAsk" | "affirmOffer" | "declineOffer" | "none";

const ASK_PATTERNS: RegExp[] = [
  /\bbrief(?:ing|ed|s)?\b/i,
  /\bbreif(?:ing|ed|s)?\b/i, // common typo
  /\bdaily\s+brief\b/i,
  /\bmorning\s+brief\b/i,
  /\brundown\b/i,
  /\bwhat's\s+on\s+my\s+plate\b/i,
  /\bwhats\s+on\s+my\s+plate\b/i,
];

const AFFIRM_RE =
  /^(yes|yeah|yep|yup|sure|ok|okay|alright|all\s*right|go\s*ahead|please|do\s*it|ready|sounds\s*good|affirmative)([.!?]|\s|$)/i;

const DECLINE_RE =
  /\b(no|nah|nope|not\s+now|later|skip|pass|don't|dont)\b/i;

const LAUNCH_PATTERNS: RegExp[] = [
  /\blaunch(?:es|ing)?\b/i,
  /\brocket(?:s)?\b/i,
  /\bspacex\b/i,
  /\bspace\s*x\b/i,
  /\bvandenberg\b/i,
  /\bcape\s+canaveral\b/i,
];

/** True when the user asked to include rocket launches in this briefing. */
export function wantsLaunches(text: string): boolean {
  return LAUNCH_PATTERNS.some((re) => re.test(text));
}

/**
 * Deterministic briefing intent. Affirm/decline only apply when an offer is pending.
 */
export function detectBriefingIntent(
  text: string,
  offerPending: boolean,
): BriefingIntentKind {
  const trimmed = text.trim();
  if (!trimmed) return "none";

  if (ASK_PATTERNS.some((re) => re.test(trimmed))) {
    return "explicitAsk";
  }

  if (!offerPending) return "none";

  if (DECLINE_RE.test(trimmed) && !/\byes\b/i.test(trimmed)) {
    // Prefer decline when user says "no" / "not now"
    if (/^(no|nah|nope)\b/i.test(trimmed) || /\bnot\s+now\b/i.test(trimmed) || /\bskip\b/i.test(trimmed)) {
      return "declineOffer";
    }
    if (DECLINE_RE.test(trimmed) && trimmed.length < 48) {
      return "declineOffer";
    }
  }

  // Short affirmation (optionally with trailing politeness).
  // STT often inserts commas: "Yes, please. I would."
  const normalized = trimmed
    .replace(/[.!?]+$/g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 48 && AFFIRM_RE.test(normalized)) {
    return "affirmOffer";
  }

  return "none";
}
