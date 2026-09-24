export type NewsIntent =
  | { kind: "headlines" }
  | { kind: "article"; index?: number; match?: string };

const TALKING_ABOUT_TOOL =
  /\b(get[_\s-]*news[_\s-]*headlines|summarize[_\s-]*news[_\s-]*article)\b/i;

const HEADLINES_ASK =
  /\b((what('?s| is)\s+(in\s+)?(the\s+)?news)|(any\s+(news|headlines))|(news\s+(headlines|update|rundown|brief))|(top\s+headlines)|((give|read|tell)\s+me\s+(the\s+)?(news|headlines))|(catch\s+me\s+up\s+on\s+(the\s+)?news)|(what('?s| is)\s+happening\s+(in\s+the\s+news|today\s+in\s+the\s+news)))\b/i;

const ARTICLE_CUE =
  /\b((tell|read|give)\s+me\s+more|(dig|go)\s+(deeper|into)|(more\s+(about|on|detail))|(summarize|summary|expand|open|fetch|pull\s+up)|(what('?s| is)\s+(that|this|the)\s+(one|story|article|headline)\s+about)|(read\s+(that|this|the)\s+(one|story|article|headline)))\b/i;

const ORDINAL: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
  last: -1,
};

/**
 * True when the utterance is asking for headlines or a follow-up on one of them.
 */
export function looksLikeNewsTask(text: string): boolean {
  return parseNewsIntent(text) != null;
}

/**
 * Deterministic news ask from casual speech.
 * Article follow-ups still need the last headline rundown in session state.
 */
export function parseNewsIntent(text: string): NewsIntent | null {
  const raw = text.trim();
  if (!raw || TALKING_ABOUT_TOOL.test(raw)) return null;

  if (HEADLINES_ASK.test(raw) && !ARTICLE_CUE.test(raw)) {
    return { kind: "headlines" };
  }

  if (ARTICLE_CUE.test(raw) || /\b(headline|story|article)\b/i.test(raw)) {
    const index = extractHeadlineIndex(raw);
    const match = extractHeadlineMatch(raw);
    if (index != null || match || ARTICLE_CUE.test(raw)) {
      return {
        kind: "article",
        ...(index != null ? { index } : {}),
        ...(match ? { match } : {}),
      };
    }
  }

  // Bare "the second one" / "number three" after a news rundown.
  const bareIndex = extractHeadlineIndex(raw);
  if (
    bareIndex != null &&
    /\b(one|headline|story|article|that|this)\b/i.test(raw)
  ) {
    return { kind: "article", index: bareIndex };
  }

  return null;
}

export function extractHeadlineIndex(text: string): number | undefined {
  const numbered = text.match(
    /\b(?:number|no\.?|#|headline|story|article)\s*(\d{1,2})\b/i,
  );
  if (numbered?.[1]) {
    const n = Number(numbered[1]);
    if (Number.isFinite(n) && n >= 1) return Math.min(20, Math.floor(n));
  }
  const ordinalWord = text.match(
    /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/i,
  );
  if (ordinalWord?.[1]) {
    const key = ordinalWord[1].toLowerCase();
    const value = ORDINAL[key];
    if (value != null) return value;
  }
  return undefined;
}

function extractHeadlineMatch(text: string): string | undefined {
  const quoted =
    text.match(/["“]([^"”]{4,80})["”]/)?.[1] ??
    text.match(/\b(?:about|on|regarding)\s+(.+?)(?:\s*[?.!]|$)/i)?.[1];
  if (!quoted) return undefined;
  let place = quoted
    .replace(/\b(the\s+)?(first|second|third|fourth|fifth|last)\s+(one|headline|story|article)\b/gi, " ")
    .replace(/\b(please|thanks|thank you|headline|story|article)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (place.length < 4) return undefined;
  return place.slice(0, 80);
}

/** Resolve -1 (last) against a concrete rundown length. */
export function resolveNewsArticleIndex(
  intent: Extract<NewsIntent, { kind: "article" }>,
  headlineCount: number,
): { index?: number; match?: string } {
  let index = intent.index;
  if (index === -1 && headlineCount > 0) index = headlineCount;
  if (index != null && index < 1) index = undefined;
  return {
    ...(index != null ? { index } : {}),
    ...(intent.match ? { match: intent.match } : {}),
  };
}
