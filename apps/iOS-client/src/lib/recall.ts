/**
 * Recall (§11.1.3, §11.3).
 *
 * One place decides where an answer came from. Every recall goes to the Mac
 * first — it has the semantic index, the graph and the reasoning. What comes
 * back is folded into the phone's mirror. If the Mac can't be reached, the
 * mirror answers instead, and the result says so.
 *
 * Failures are not all the same. A dead network falls back to the copy; a Mac
 * that turned this phone away does not, because showing memory to a device that
 * has just been de-authorised would be exactly the wrong instinct.
 */
import {
  ApiError,
  dueReminders,
  getEpisode,
  isNotBuiltYet,
  recentMemories,
  searchMemory,
} from "./desktop-api";
import {
  localDue,
  localMemory,
  localRecent,
  localSearch,
  mirrorSyncedAt,
  useMirror,
} from "./memory-cache";
import type { Memory, MemoryKind } from "./types";

/** Where the records on screen actually came from. */
export type RecallSource = "desktop" | "phone";

export interface Recalled<T> {
  data: T;
  source: RecallSource;
  /** Only set for phone answers: when the desktop last confirmed the copy. */
  cachedAt: string | null;
  /** Only set for phone answers: why the Mac didn't answer. */
  reason: string | null;
}

/**
 * Reachability, capability and server faults are the phone's business to paper
 * over. Auth failures are not — those the user needs to see.
 */
function canFallBack(error: unknown): boolean {
  if (isNotBuiltYet(error)) return true;
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401 || error.status === 403) return false;
  if (error.code === "cloud_unauthorized") return false;
  return (
    error.status === 0 ||
    error.status >= 500 ||
    error.code === "not_connected" ||
    error.code === "network_error" ||
    error.code === "desktop_unreachable"
  );
}

function fromDesktop<T>(data: T): Recalled<T> {
  return { data, source: "desktop", cachedAt: null, reason: null };
}

function fromPhone<T>(data: T, error: unknown): Recalled<T> {
  return {
    data,
    source: "phone",
    cachedAt: mirrorSyncedAt(),
    reason: isNotBuiltYet(error)
      ? "Your Mac is connected, but its memory service isn't in that build yet."
      : "Your Mac isn't reachable right now.",
  };
}

function remember(memories: Memory[]): void {
  useMirror.getState().put(memories);
}

/**
 * Run a desktop recall, mirror what it returns, and fall back to the copy on
 * this phone when the Mac is out of reach. `local` is only consulted on failure
 * — a reachable Mac always wins, even if the copy looks fuller.
 */
async function recall<T>(
  fromMac: () => Promise<T>,
  mirror: (result: T) => Memory[],
  local: () => T | null
): Promise<Recalled<T>> {
  try {
    const result = await fromMac();
    remember(mirror(result));
    return fromDesktop(result);
  } catch (error) {
    if (!canFallBack(error)) throw error;
    const fallback = local();
    if (fallback === null) throw error;
    return fromPhone(fallback, error);
  }
}

export function recallRecent(limit = 30) {
  return recall<{ memories: Memory[] }>(
    () => recentMemories(limit),
    (result) => result.memories,
    () => {
      const memories = localRecent(limit);
      return memories.length > 0 ? { memories } : null;
    }
  );
}

export function recallSearch(query: string, opts: { limit?: number; kinds?: MemoryKind[] } = {}) {
  return recall<{ interpretedAs: string; results: Memory[] }>(
    () => searchMemory(query, opts),
    (result) => result.results,
    () => ({
      // The phone matches words. Saying it read the question would be a lie.
      interpretedAs: `words matching “${query.trim()}”`,
      results: localSearch(query, opts),
    })
  );
}

export function recallOne(id: string) {
  return recall<{ memory: Memory }>(
    () => getEpisode(id),
    (result) => [result.memory],
    () => {
      const memory = localMemory(id);
      return memory ? { memory } : null;
    }
  );
}

export function recallDue() {
  return recall<{ date: string; timezone: string; reminders: Memory[] }>(
    () => dueReminders(),
    (result) => result.reminders,
    () => ({
      date: new Date().toISOString().slice(0, 10),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      reminders: localDue(),
    })
  );
}

/** "Kept on this phone · last confirmed 2 hours ago" — for the source line. */
export function describeCopy(cachedAt: string | null): string {
  if (!cachedAt) return "This is the copy kept on this phone.";
  const then = new Date(cachedAt).getTime();
  if (Number.isNaN(then)) return "This is the copy kept on this phone.";

  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 2) return "This is the copy kept on this phone, confirmed just now.";
  if (minutes < 60) return `This is the copy kept on this phone, last confirmed ${minutes} minutes ago.`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `This is the copy kept on this phone, last confirmed ${hours} hour${hours === 1 ? "" : "s"} ago.`;
  }
  const days = Math.round(hours / 24);
  return `This is the copy kept on this phone, last confirmed ${days} day${days === 1 ? "" : "s"} ago.`;
}
