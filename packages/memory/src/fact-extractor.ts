/**
 * Local heuristic fact extraction from user utterances.
 * Upserts use stable sourceIds (e.g. fact:name) so repeats overwrite.
 */

export type MemoryKind = "fact" | "turn" | "note";

export interface ExtractedFact {
  sourceId: string;
  content: string;
}

const FALSE_NAME =
  /^(a|an|the|not|going|trying|here|just|glad|sorry|fine|good|okay|ok|back|ready|done|sure|still|also|only|really|very|alfred|albert|butler)$/i;

export function extractFactsFromUserText(text: string): ExtractedFact[] {
  const t = text.trim();
  if (!t) return [];
  const facts: ExtractedFact[] = [];
  const lower = t.toLowerCase();

  // "my name is Devon" / "I'm Devon" / "I am Devon" / "call me Devon"
  const nameMatch =
    t.match(/\bmy name is\s+([A-Za-z][\w'-]+(?:\s+[A-Za-z][\w'-]+)?)/i) ??
    t.match(/\b(?:call me|i go by)\s+([A-Za-z][\w'-]+)\b/i) ??
    t.match(/\b(?:i am|i'm)\s+([A-Za-z][\w'-]+)\b/i);
  if (nameMatch?.[1]) {
    const name = titleCaseName(nameMatch[1].trim());
    // Skip assistant self-echo ("I'm Alfred, your digital butler…")
    const isAssistantEcho =
      /\b(?:digital butler|your butler|i'?m alfred|i'?m albert)\b/i.test(t) ||
      FALSE_NAME.test(name);
    if (!isAssistantEcho && name.length >= 2) {
      facts.push({ sourceId: "fact:name", content: `User's name is ${name}.` });
    }
  }

  // Job / role: "my job is X", "I work as a X", "I'm a software developer"
  const jobMatch =
    t.match(/\bmy job(?:\s+is|\s*'?s)\s+(.+?)(?:[.!?,]|$)/i) ??
    t.match(/\bi work(?:\s+as)?(?:\s+a|\s+an)?\s+(.+?)(?:[.!?,]|$)/i) ??
    t.match(/\bi'?m\s+a(?:n)?\s+([A-Za-z][\w\s/-]{2,40}?)(?:[.!?,]|$)/i);
  if (jobMatch?.[1]) {
    const job = cleanPhrase(jobMatch[1]);
    if (job && !/^(bit|little|lot|fan|friend)/i.test(job)) {
      facts.push({ sourceId: "fact:job", content: `User's job/role is ${job}.` });
    }
  }

  // "I prefer X" / "I like X" / "my favorite X is Y"
  const preferMatch = t.match(/\bi (?:prefer|like)\s+(.+?)(?:[.!?]|$)/i);
  if (preferMatch?.[1]) {
    const pref = cleanPhrase(preferMatch[1]);
    if (pref && pref.split(/\s+/).length <= 12) {
      facts.push({
        sourceId: "fact:preference",
        content: `User prefers ${pref}.`,
      });
    }
  }
  const favoriteMatch = t.match(/\bmy favorite\s+(\w+)\s+is\s+(.+?)(?:[.!?]|$)/i);
  if (favoriteMatch?.[1] && favoriteMatch[2]) {
    facts.push({
      sourceId: `fact:favorite:${favoriteMatch[1].toLowerCase()}`,
      content: `User's favorite ${favoriteMatch[1]} is ${cleanPhrase(favoriteMatch[2])}.`,
    });
  }

  // Explicit remember / note / for the record
  const rememberMatch = t.match(
    /\b(?:remember that|don't forget(?: that)?|keep in mind(?: that)?|note that|for the record|you should know(?: that)?|the important thing is)\s+(.+?)(?:[.!?]|$)/i,
  );
  if (rememberMatch?.[1]) {
    const note = cleanPhrase(rememberMatch[1]);
    if (note.length >= 4) {
      facts.push({
        sourceId: `fact:note:${slug(note).slice(0, 40)}`,
        content: note.endsWith(".") ? note : `${note}.`,
      });
    }
  }

  // "today is August 6" / "feed you with August sixth"
  const dayNum =
    "\\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|" +
    "eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|" +
    "twentieth|twenty[- ]?first|twenty[- ]?second|twenty[- ]?third|twenty[- ]?fourth|twenty[- ]?fifth|" +
    "twenty[- ]?sixth|twenty[- ]?seventh|twenty[- ]?eighth|twenty[- ]?ninth|thirtieth|thirty[- ]?first";
  const month =
    "january|february|march|april|may|june|july|august|september|october|november|december";
  const dateRe = new RegExp(
    `\\b(?:today is|it'?s|the date is|remember(?: that)?(?:\\s+today)?(?:\\s+is)?)\\s+((?:${month})\\s+(?:${dayNum})(?:,?\\s*\\d{4})?)` +
      `|\\bfeed you\\b[\\s\\S]{0,60}?\\b((?:${month})\\s+(?:${dayNum})(?:,?\\s*\\d{4})?)`,
    "i",
  );
  const dateMatch = t.match(dateRe);
  const datePhrase = dateMatch?.[1] ?? dateMatch?.[2];
  if (datePhrase) {
    facts.push({
      sourceId: "fact:today_date",
      content: `User said today's date is ${cleanPhrase(datePhrase)}.`,
    });
  }

  // "I live in X" / "I'm based in X"
  const liveMatch = t.match(/\bi (?:live|am based) in\s+(.+?)(?:[.!?]|$)/i);
  if (liveMatch?.[1]) {
    facts.push({
      sourceId: "fact:location",
      content: `User lives in ${cleanPhrase(liveMatch[1])}.`,
    });
  }

  // Dark/light mode style prefs
  if (/\b(?:prefer|like|use)\s+dark mode\b/i.test(lower)) {
    facts.push({ sourceId: "fact:ui_theme", content: "User prefers dark mode." });
  } else if (/\b(?:prefer|like|use)\s+light mode\b/i.test(lower)) {
    facts.push({ sourceId: "fact:ui_theme", content: "User prefers light mode." });
  }

  return facts;
}

function cleanPhrase(s: string): string {
  return s
    .trim()
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\buh+\b|\bum+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function titleCaseName(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function getItemKind(item: { provenance?: Record<string, unknown> }): MemoryKind {
  const k = item.provenance?.kind;
  if (k === "fact" || k === "turn" || k === "note") return k;
  return "turn";
}
