/**
 * Local heuristic fact extraction from user utterances.
 * Upserts use stable sourceIds (e.g. fact:name) so repeats overwrite.
 */

export type MemoryKind = "fact" | "turn" | "note";

export interface ExtractedFact {
  sourceId: string;
  content: string;
}

export function extractFactsFromUserText(text: string): ExtractedFact[] {
  const t = text.trim();
  if (!t) return [];
  const facts: ExtractedFact[] = [];
  const lower = t.toLowerCase();

  // "my name is Devon" / "I'm Devon" / "I am Devon"
  const nameMatch =
    t.match(/\bmy name is\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/i) ??
    t.match(/\b(?:i am|i'm)\s+([A-Z][\w'-]+)\b/);
  if (nameMatch?.[1]) {
    const name = nameMatch[1].trim();
    // Avoid capturing common false positives
    if (!/^(a|an|the|not|going|trying|here|just)$/i.test(name)) {
      facts.push({ sourceId: "fact:name", content: `User's name is ${name}.` });
    }
  }

  // "I prefer X" / "I like X" / "my favorite X is Y"
  const preferMatch = t.match(/\bi (?:prefer|like)\s+(.+?)(?:[.!?]|$)/i);
  if (preferMatch?.[1]) {
    facts.push({
      sourceId: "fact:preference",
      content: `User prefers ${preferMatch[1].trim().replace(/\.$/, "")}.`,
    });
  }
  const favoriteMatch = t.match(/\bmy favorite\s+(\w+)\s+is\s+(.+?)(?:[.!?]|$)/i);
  if (favoriteMatch?.[1] && favoriteMatch[2]) {
    facts.push({
      sourceId: `fact:favorite:${favoriteMatch[1].toLowerCase()}`,
      content: `User's favorite ${favoriteMatch[1]} is ${favoriteMatch[2].trim().replace(/\.$/, "")}.`,
    });
  }

  // "remember that ..." / "don't forget ..."
  const rememberMatch = t.match(/\b(?:remember that|don't forget(?: that)?)\s+(.+?)(?:[.!?]|$)/i);
  if (rememberMatch?.[1]) {
    const note = rememberMatch[1].trim().replace(/\.$/, "");
    facts.push({
      sourceId: `fact:note:${slug(note).slice(0, 40)}`,
      content: note.endsWith(".") ? note : `${note}.`,
    });
  }

  // "I live in X" / "I'm in X"
  const liveMatch = t.match(/\bi (?:live|am based) in\s+(.+?)(?:[.!?]|$)/i);
  if (liveMatch?.[1]) {
    facts.push({
      sourceId: "fact:location",
      content: `User lives in ${liveMatch[1].trim().replace(/\.$/, "")}.`,
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
