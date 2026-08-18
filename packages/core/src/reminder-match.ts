import type { DueReminderSummary } from "./ports.js";

export type ReminderMatchResult =
  | { kind: "exact"; reminder: DueReminderSummary }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: DueReminderSummary[] };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length > 2);
}

function scoreMatch(query: string, summary: string): number {
  const q = normalize(query);
  const s = normalize(summary);
  if (!q || !s) return 0;
  if (s === q) return 100;
  if (s.includes(q) || q.includes(s)) return 80;
  const qt = tokens(query);
  const st = new Set(tokens(summary));
  if (!qt.length) return 0;
  let hit = 0;
  for (const t of qt) {
    if (st.has(t)) hit += 1;
  }
  return (hit / qt.length) * 60;
}

/**
 * Resolve which due reminder the user/LLM meant.
 * Prefer recordId; otherwise require a single clear text match.
 */
export function resolveReminderMatch(
  due: DueReminderSummary[],
  opts: { recordId?: string | null; match?: string | null },
): ReminderMatchResult {
  const recordId = opts.recordId?.trim();
  if (recordId) {
    const found = due.find(
      (r) => r.recordId === recordId || r.recordId.endsWith(recordId) || recordId.endsWith(r.recordId),
    );
    if (found) return { kind: "exact", reminder: found };
  }

  const match = opts.match?.trim();
  if (!match) {
    if (due.length === 1) return { kind: "exact", reminder: due[0]! };
    return due.length ? { kind: "ambiguous", candidates: due } : { kind: "none" };
  }

  const scored = due
    .map((reminder) => ({ reminder, score: scoreMatch(match, reminder.summary) }))
    .filter((x) => x.score >= 25)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { kind: "none" };
  const top = scored[0]!;
  const close = scored.filter((x) => x.score >= top.score - 8);
  if (close.length > 1 && close[1]!.score >= 40) {
    return { kind: "ambiguous", candidates: close.map((c) => c.reminder) };
  }
  return { kind: "exact", reminder: top.reminder };
}
