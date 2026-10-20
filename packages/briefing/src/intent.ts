import { looksLikeAddBriefingModule } from "./modules.js";

export type BriefingIntentKind =
  | "explicitAsk"
  | "affirmOffer"
  | "declineOffer"
  | "affirmNewsOffer"
  | "declineNewsOffer"
  | "none";

export type BriefingOfferFlags = {
  offerPending?: boolean;
  newsOfferPending?: boolean;
};

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

function normalizeOfferFlags(
  offer: boolean | BriefingOfferFlags | undefined,
): Required<BriefingOfferFlags> {
  if (typeof offer === "boolean") {
    return { offerPending: offer, newsOfferPending: false };
  }
  return {
    offerPending: Boolean(offer?.offerPending),
    newsOfferPending: Boolean(offer?.newsOfferPending),
  };
}

function isDecline(trimmed: string): boolean {
  if (!DECLINE_RE.test(trimmed) || /\byes\b/i.test(trimmed)) return false;
  if (/^(no|nah|nope)\b/i.test(trimmed) || /\bnot\s+now\b/i.test(trimmed) || /\bskip\b/i.test(trimmed)) {
    return true;
  }
  return DECLINE_RE.test(trimmed) && trimmed.length < 48;
}

function isAffirm(trimmed: string): boolean {
  const normalized = trimmed
    .replace(/[.!?]+$/g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= 48 && AFFIRM_RE.test(normalized);
}

/**
 * Deterministic briefing intent. Affirm/decline only apply when an offer is pending.
 * News-offer pending is checked before the soft briefing offer.
 */
export function detectBriefingIntent(
  text: string,
  offer: boolean | BriefingOfferFlags = false,
): BriefingIntentKind {
  const trimmed = text.trim();
  if (!trimmed) return "none";

  // "Add rocket launches to my briefing" mentions briefing without asking to hear it.
  if (looksLikeAddBriefingModule(trimmed)) return "none";

  if (ASK_PATTERNS.some((re) => re.test(trimmed))) {
    return "explicitAsk";
  }

  const { offerPending, newsOfferPending } = normalizeOfferFlags(offer);

  if (newsOfferPending) {
    if (isDecline(trimmed)) return "declineNewsOffer";
    if (isAffirm(trimmed)) return "affirmNewsOffer";
    return "none";
  }

  if (!offerPending) return "none";

  if (isDecline(trimmed)) return "declineOffer";
  if (isAffirm(trimmed)) return "affirmOffer";

  return "none";
}
