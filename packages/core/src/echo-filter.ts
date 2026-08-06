/**
 * Transcript-based acoustic echo filter.
 * While Alfred is speaking (or shortly after), mic STT that matches
 * recent assistant — or the user turn being answered — is treated as echo.
 *
 * Mixed turns are common: STT glues speaker echo + a real barge-in into one
 * transcript ("I'm Alfred… Hey hold up, say blue"). Those must still interrupt.
 */

export function normalizeForEcho(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface EchoCheckInput {
  heard: string;
  /** Assistant TTS text currently / recently playing. */
  assistantSpeech?: string;
  /** User turn we are answering — STT often re-hears or re-finalizes it. */
  userTurn?: string;
  /** When true, short/garbled fragments are treated as echo more aggressively. */
  aggressiveShort?: boolean;
}

/**
 * True when `heard` looks like speaker echo / STT re-hear, not a new barge-in.
 */
export function looksLikeAssistantEcho(heard: string, spoken: string): boolean {
  return isEchoTranscript({ heard, assistantSpeech: spoken, aggressiveShort: true });
}

export function isEchoTranscript(input: EchoCheckInput): boolean {
  // Mixed echo+interrupt is NOT pure echo.
  if (isConfidentBargeIn(input)) return false;

  const h = normalizeForEcho(input.heard);
  if (!h) return true;

  const refs = [input.assistantSpeech, input.userTurn]
    .map((t) => (t ? normalizeForEcho(t) : ""))
    .filter(Boolean);

  if (refs.length === 0) return false;

  const hTokens = tokenize(h);
  if (input.aggressiveShort !== false) {
    if (h.length < 6) return true;
    if (hTokens.length <= 2) return true;
  }

  for (const s of refs) {
    if (matchesReference(h, hTokens, s)) return true;
  }
  return false;
}

const INTERRUPT_CUE =
  /\b(stop talking|shut up|be quiet|say the word|say(?:\s+the)?\s+\w+|hold on|hold up|wait(?:\s+up)?|wait stop|cut it out|hang on)\b/i;

/** Novel suffix that looks like the user starting to address Alfred. */
const DISCOURSE_START =
  /^(hey|hi|hello|ok|okay|wait|hold|stop|no|nope|nah|actually|sorry|um+|uh+|can you|could you|please|listen)\b/i;

/** Explicit interrupt / command cues (hold on, say red, stop talking, …). */
export function hasInterruptCue(text: string): boolean {
  return INTERRUPT_CUE.test(text.trim());
}

/**
 * True when heard looks like a noisy STT replay of assistant speech
 * (e.g. "You're Devon James, a software developer" → "You would debit James as developers").
 */
export function isNoisyReplay(heard: string, spoken: string): boolean {
  const hTokens = tokenize(normalizeForEcho(heard)).filter((t) => t.length >= 3);
  const sTokens = tokenize(normalizeForEcho(spoken)).filter((t) => t.length >= 3);
  if (hTokens.length < 3 || sTokens.length < 3) return false;

  const closeHits = hTokens.filter((ht) =>
    sTokens.some((st) => tokensEchoClose(ht, st)),
  ).length;
  const ratio = closeHits / hTokens.length;
  if (ratio >= 0.55 && closeHits >= 3) return true;

  // Short garbled fragments that still land on distinctive spoken content words
  // ("would debit James" ≈ "Devon James").
  const contentHits = hTokens.filter((ht) =>
    sTokens.some((st) => st.length >= 4 && tokensEchoClose(ht, st)),
  ).length;
  if (hTokens.length <= 8 && contentHits >= 3 && contentHits / hTokens.length >= 0.45) {
    return true;
  }
  const strong = hTokens.some((ht) =>
    sTokens.some((st) => st.length >= 5 && tokensEchoClose(ht, st)),
  );
  return hTokens.length <= 6 && strong && closeHits >= 2 && ratio >= 0.5;
}

/**
 * True when heard is substantial *novel* speech (confident barge-in).
 * Handles echo-prefix + interrupt-suffix mixes from the mic.
 */
export function isConfidentBargeIn(input: EchoCheckInput): boolean {
  const raw = input.heard.trim();
  if (!raw) return false;
  if (hasInterruptCue(raw)) return true;

  // Garbled self-echo often looks "novel" after fuzzy strip — reject first.
  if (input.assistantSpeech && isNoisyReplay(raw, input.assistantSpeech)) {
    return false;
  }

  const novel = novelSpeech(input);
  if (!novel) return false;
  if (hasInterruptCue(novel)) return true;
  if (input.assistantSpeech && isNoisyReplay(novel, input.assistantSpeech)) {
    return false;
  }

  const novelTokens = tokenize(normalizeForEcho(novel));
  const content = novelTokens.filter((t) => t.length >= 3);
  if (content.length < 3) return false;

  // Nearly-full replay of assistant + trailing STT junk ("at discretion…") is not a barge-in.
  if (input.assistantSpeech) {
    const coverage = spokenCoverageRatio(raw, input.assistantSpeech);
    if (coverage >= 0.55 && !DISCOURSE_START.test(novel.trim())) {
      return false;
    }
  }

  return DISCOURSE_START.test(novel.trim()) || content.length >= 4;
}

function spokenCoverageRatio(heard: string, spoken: string): number {
  const hTokens = tokenize(normalizeForEcho(heard));
  const sTokens = tokenize(normalizeForEcho(spoken));
  if (sTokens.length === 0) return 0;
  const hits = sTokens.filter((st) => hTokens.some((t) => tokensEchoClose(t, st))).length;
  return hits / sTokens.length;
}

/**
 * Prefer the novel interrupt for the committed turn:
 * drop leading assistant-echo and trailing echo glued on by STT.
 */
export function extractBargeInText(input: EchoCheckInput): string {
  let text = input.heard.trim();
  const novel = novelSpeech(input);
  if (novel && tokenize(normalizeForEcho(novel)).length >= 2) {
    text = novel;
  }
  if (input.assistantSpeech) {
    text = stripTrailingEcho(text, input.assistantSpeech);
  }
  return text.trim();
}

/** Peel trailing sentences/tokens that are mostly a replay of assistant speech. */
function stripTrailingEcho(heard: string, spoken: string): string {
  const sentences = heard.split(/(?<=[.!?…])\s+/).filter((s) => s.trim());
  if (sentences.length <= 1) return peelTrailingEchoTokens(heard, spoken);

  while (sentences.length > 1) {
    const last = sentences[sentences.length - 1]!.trim();
    if (INTERRUPT_CUE.test(last)) break;
    const lastTokens = tokenize(normalizeForEcho(last));
    if (lastTokens.length === 0) {
      sentences.pop();
      continue;
    }
    const ratio = spokenCoverageRatio(last, spoken);
    const allExplained = lastTokens.every((t) =>
      tokenize(normalizeForEcho(spoken)).some((st) => tokensEchoClose(t, st)),
    );
    if (ratio >= 0.4 || allExplained) {
      sentences.pop();
      continue;
    }
    break;
  }
  const joined = sentences.join(" ").trim();
  return peelTrailingEchoTokens(joined, spoken);
}

function peelTrailingEchoTokens(heard: string, spoken: string): string {
  const hTokens = tokenize(normalizeForEcho(heard));
  const sTokens = tokenize(normalizeForEcho(spoken));
  if (hTokens.length < 4 || sTokens.length < 2) return heard;

  let end = hTokens.length;
  while (end > 2) {
    const tok = hTokens[end - 1]!;
    if (/^(hold|on|up|say|red|blue|green|please|wait|stop|can|you)\b/i.test(tok)) break;
    if (!sTokens.some((st) => tokensEchoClose(tok, st))) break;
    const kept = hTokens.slice(0, end - 1).join(" ");
    if (!INTERRUPT_CUE.test(kept) && kept.split(/\s+/).filter((t) => t.length >= 3).length < 3) {
      break;
    }
    end -= 1;
  }
  const strip = hTokens.length - end;
  if (strip <= 0) return heard;
  return sliceBeforeLastTokens(heard, strip);
}

function sliceBeforeLastTokens(original: string, stripTokens: number): string {
  const parts = original.trim().split(/(\s+)/);
  let seen = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (!part.trim()) continue;
    if (!normalizeForEcho(part)) continue;
    seen += 1;
    if (seen >= stripTokens) {
      return parts.slice(0, i).join("").trim();
    }
  }
  return original.trim();
}

/** Text after stripping a leading span that looks like assistant/user echo. */
function novelSpeech(input: EchoCheckInput): string | undefined {
  const heard = input.heard.trim();
  if (!heard) return undefined;

  const refs = [input.assistantSpeech, input.userTurn].filter(
    (t): t is string => Boolean(t && t.trim()),
  );
  if (refs.length === 0) return heard;

  const hTokens = tokenize(normalizeForEcho(heard));
  const refTokenLists = refs.map((r) => tokenize(normalizeForEcho(r)));

  // How many leading heard tokens are explained by any reference?
  let echoPrefix = 0;
  for (let i = 0; i < hTokens.length; i++) {
    const tok = hTokens[i]!;
    const explained = refTokenLists.some((rt) => rt.some((st) => tokensEchoClose(tok, st)));
    if (!explained) break;
    echoPrefix += 1;
  }

  // Also allow a fuzzy contiguous prefix against assistant tokens.
  if (input.assistantSpeech) {
    const sTokens = tokenize(normalizeForEcho(input.assistantSpeech));
    let k = 0;
    while (
      k < hTokens.length &&
      k < sTokens.length &&
      tokensEchoClose(hTokens[k]!, sTokens[k]!)
    ) {
      k += 1;
    }
    // Or find longest leading heard run that appears as a contiguous window in spoken.
    let bestLead = k;
    for (let start = 0; start < sTokens.length; start++) {
      let n = 0;
      while (
        n < hTokens.length &&
        start + n < sTokens.length &&
        tokensEchoClose(hTokens[n]!, sTokens[start + n]!)
      ) {
        n += 1;
      }
      if (n > bestLead) bestLead = n;
    }
    echoPrefix = Math.max(echoPrefix, bestLead);
  }

  if (echoPrefix <= 0) {
    // No echo prefix — whole thing may still be novel (unless it's a noisy replay).
    if (input.assistantSpeech && isNoisyReplay(heard, input.assistantSpeech)) {
      return undefined;
    }
    const allRef = refTokenLists.flat();
    const novelCount = hTokens.filter(
      (t) => !allRef.some((st) => tokensEchoClose(t, st)),
    ).length;
    if (novelCount >= 3) return heard;
    return undefined;
  }

  if (echoPrefix >= hTokens.length) return undefined;

  // Map token index back to original heard string roughly by walking normalized words.
  const remainder = sliceAfterTokens(heard, echoPrefix);
  const remTokens = tokenize(normalizeForEcho(remainder));
  if (remTokens.filter((t) => t.length >= 3).length >= 2) return remainder.trim();
  return undefined;
}

function sliceAfterTokens(original: string, skipTokens: number): string {
  const parts = original.trim().split(/(\s+)/);
  let seen = 0;
  let idx = 0;
  for (; idx < parts.length; idx++) {
    const part = parts[idx]!;
    if (!part.trim()) continue;
    // Count as a token if it has a word-ish character after normalize.
    const norm = normalizeForEcho(part);
    if (!norm) continue;
    seen += 1;
    if (seen > skipTokens) {
      // Include this token in remainder — we skipped `skipTokens` already.
      // Actually when seen becomes skipTokens+1 we're at first novel token.
      return parts.slice(idx).join("");
    }
  }
  return "";
}

function matchesReference(h: string, hTokens: string[], s: string): boolean {
  if (!s) return false;
  if (s.includes(h)) return true;
  if (h.includes(s) && s.length >= 10) return true;
  if (isNoisyReplay(h, s)) return true;

  const sTokens = tokenize(s);
  if (hTokens.length === 0) return true;
  if (sTokens.length === 0) return false;

  const hits = hTokens.filter((t) => sTokens.some((st) => tokensEchoClose(t, st))).length;
  const ratio = hits / hTokens.length;

  // High overlap = echo even with a trailing STT garbage tail.
  // But require the remainder after a long echo prefix to also be thin — handled by isConfidentBargeIn first.
  if (hits >= 5 && ratio >= 0.5) return true;
  if (ratio >= 0.65 && hTokens.length <= sTokens.length + 6) return true;

  if (longestFuzzyContiguous(hTokens, sTokens) >= 4) return true;
  if (longestFuzzyContiguous(sTokens, hTokens) >= 5) return true;

  const spokenHits = sTokens.filter((st) => hTokens.some((t) => tokensEchoClose(t, st))).length;
  if (sTokens.length >= 6 && spokenHits / sTokens.length >= 0.4 && hits >= 5) return true;

  if (hTokens.length <= 3) {
    const content = hTokens.filter((t) => t.length >= 4);
    if (
      content.length > 0 &&
      content.every((t) => sTokens.some((st) => tokensEchoClose(t, st)))
    ) {
      return true;
    }
  }

  return false;
}

function tokenize(text: string): string[] {
  return text.split(" ").filter((t) => t.length > 1);
}

function tokensFuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    if (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))) {
      if (Math.abs(a.length - b.length) <= 3) return true;
    }
  }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) return false;
  const dist = levenshtein(a, b);
  if (maxLen <= 5) return dist <= 1;
  // Names like alfred/albert often garble at distance 3.
  if (maxLen >= 6 && a.slice(0, 3) === b.slice(0, 3) && Math.abs(a.length - b.length) <= 2) {
    return dist <= 3;
  }
  return dist <= 2;
}

/**
 * Looser match for speakerphone garble (Devon↔debit, you're↔you, digital↔debit).
 * Used for echo detection only — not for general string equality.
 */
function tokensEchoClose(a: string, b: string): boolean {
  if (tokensFuzzyEqual(a, b)) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) {
    // you're / you / you'd
    if (a.startsWith(b) || b.startsWith(a)) return Math.min(a.length, b.length) >= 3;
    return false;
  }
  const dist = levenshtein(a, b);
  // devon/debit: shared "de", edit distance 3
  if (a.slice(0, 2) === b.slice(0, 2) && Math.abs(a.length - b.length) <= 2 && dist <= 3) {
    return true;
  }
  const sk = (w: string) => w.replace(/[aeiou]/g, "");
  const sa = sk(a);
  const sb = sk(b);
  if (sa.length >= 3 && sa === sb) return true;
  if (sa.length >= 3 && sb.length >= 3 && levenshtein(sa, sb) <= 1) return true;
  return false;
}

/** True when an interrupt transcript still looks mid-sentence / incomplete. */
export function looksIncompleteInterrupt(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Ends with a cue that usually precedes the real ask.
  if (
    /\b(hold on|hold up|hang on|wait|wait up|um+|uh+|alright|okay|ok|hey|so|and|can you|could you|would you|i want you to|i need you to)\s*[.!?…]*\s*$/i.test(
      t,
    )
  ) {
    // Allow completion when the ask is already present ("can you say red, please?")
    if (/\bsay\b.+\b(please)?\s*[.!?…]?\s*$/i.test(t) && t.split(/\s+/).length >= 5) {
      return false;
    }
    if (/\bsay\b/i.test(t) && /\b(red|blue|green|yes|no|\w+)\b/i.test(t) && t.split(/\s+/).length >= 5) {
      return false;
    }
    return true;
  }
  // Very short fragments.
  if (t.split(/\s+/).filter(Boolean).length < 4 && !/\bsay\b/i.test(t)) return true;
  return false;
}

function longestFuzzyContiguous(needle: string[], haystack: string[]): number {
  let best = 0;
  for (let i = 0; i < needle.length; i++) {
    for (let j = 0; j < haystack.length; j++) {
      let k = 0;
      while (
        i + k < needle.length &&
        j + k < haystack.length &&
        tokensEchoClose(needle[i + k]!, haystack[j + k]!)
      ) {
        k += 1;
      }
      if (k > best) best = k;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}
