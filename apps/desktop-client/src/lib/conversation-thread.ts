const THREAD_MS = 15 * 60_000;
const MAX_TURNS = 12;

interface ThreadTurn {
  role: "user" | "assistant";
  text: string;
  at: number;
}

let turns: ThreadTurn[] = [];

function fresh(now = Date.now()): ThreadTurn[] {
  return turns.filter((turn) => now - turn.at < THREAD_MS);
}

/** Remember a spoken or typed line so a later calendar plan can see the whole exchange. */
export function noteConversationTurn(role: "user" | "assistant", text: string, now = Date.now()): void {
  const value = text.trim().replace(/\s+/g, " ");
  if (!value) return;
  turns = fresh(now);
  const last = turns[turns.length - 1];
  if (last && last.role === role && last.text === value) return;
  turns.push({ role, text: value.slice(0, 500), at: now });
  if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
}

/** User and Alfred lines from the last few minutes, oldest first. */
export function conversationForSchedule(now = Date.now()): string {
  turns = fresh(now);
  return turns.map((turn) => `${turn.role === "user" ? "User" : "Alfred"}: ${turn.text}`).join("\n");
}

export function resetConversationThread(): void {
  turns = [];
}
