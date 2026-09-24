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
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

const FOLLOW_CUE =
  /\b(headline|story|article|the one|that one|this one|more about|more on|what about|dig into|go deeper)\b/i;

const MATCH_STOP =
  /^(that|this|it|them|one|the one|that one|this one|the story|the headline|the article|there)$/i;

const FUZZY_STOP = new Set([
  "the",
  "a",
  "an",
  "about",
  "one",
  "that",
  "this",
  "story",
  "headline",
  "article",
  "tell",
  "more",
  "please",
  "what",
  "with",
  "from",
  "have",
  "want",
  "into",
  "dig",
  "read",
  "give",
  "yeah",
  "yes",
  "okay",
  "just",
  "some",
  "them",
  "they",
  "there",
  "here",
  "news",
  "today",
  "alfred",
  "me",
  "and",
  "for",
  "you",
]);

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
  if (place.length < 4 || MATCH_STOP.test(place)) return undefined;
  return place.slice(0, 80);
}

const BARE_ORDINAL =
  /^(?:(?:yeah|yes|ok(?:ay)?)[, ]+)?(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)(?:\s+one)?[.!?]?$/i;

const NUMBER_WORD =
  /^(?:(?:yeah|yes|ok(?:ay)?)[, ]+)?(?:number|no\.?|#)\s*(one|two|three|four|five|\d{1,2})[.!?]?$/i;

function bareOrdinalIndex(text: string): number | undefined {
  const ordinal = text.trim().match(BARE_ORDINAL);
  if (ordinal?.[1]) return ORDINAL[ordinal[1].toLowerCase()];
  const numbered = text.trim().match(NUMBER_WORD);
  if (!numbered?.[1]) return undefined;
  const token = numbered[1].toLowerCase();
  if (ORDINAL[token] != null) return ORDINAL[token];
  const n = Number(token);
  if (Number.isFinite(n) && n >= 1) return Math.min(20, Math.floor(n));
  return undefined;
}

function fuzzyTitleIndex(text: string, titles: string[]): number | undefined {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !FUZZY_STOP.has(token) && ORDINAL[token] == null);
  if (!tokens.length || !titles.length) return undefined;
  const scores = titles.map((title) => {
    const hay = title.toLowerCase();
    return tokens.filter((token) => hay.includes(token)).length;
  });
  const best = Math.max(...scores);
  if (best <= 0) return undefined;
  const winners = scores.flatMap((score, index) => (score === best ? [index] : []));
  if (winners.length !== 1) return undefined;
  const title = titles[winners[0]!]!.toLowerCase();
  const matched = tokens.filter((token) => title.includes(token));
  const uniqueEnough = scores.filter((score) => score > 0).length === 1;
  const strong =
    matched.length >= 2 ||
    matched.some((token) => token.length >= 5) ||
    (uniqueEnough && matched.some((token) => token.length >= 3));
  if (!strong) return undefined;
  return winners[0]! + 1;
}

/**
 * Turn a follow-up into a headline index once a rundown has been spoken.
 * "ask" means they want a story but did not identify which one.
 * Null means this utterance is not a headline follow-up.
 */
export function resolveNewsFollowUp(
  text: string,
  titles: string[],
): { index?: number; match?: string } | "ask" | null {
  const raw = text.trim();
  if (!raw) return null;
  const intent = parseNewsIntent(raw);
  if (intent?.kind === "headlines") return null;

  if (intent?.kind === "article") {
    const resolved = resolveNewsArticleIndex(intent, titles.length);
    const match = resolved.match && !MATCH_STOP.test(resolved.match) ? resolved.match : undefined;
    if (resolved.index != null || match) {
      return {
        ...(resolved.index != null ? { index: resolved.index } : {}),
        ...(match ? { match } : {}),
      };
    }
    return "ask";
  }

  const ordinal = bareOrdinalIndex(raw);
  if (ordinal != null) {
    if (!titles.length) return "ask";
    const index = ordinal === -1 ? titles.length : ordinal;
    if (index >= 1 && index <= titles.length) return { index };
    return "ask";
  }

  if (!titles.length || !FOLLOW_CUE.test(raw)) return null;
  const index = fuzzyTitleIndex(raw, titles);
  return index != null ? { index } : null;
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
