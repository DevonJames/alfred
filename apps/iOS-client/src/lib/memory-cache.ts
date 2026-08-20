/**
 * On-phone memory mirror (§11.3).
 *
 * The Mac remains the source of truth: it does the extraction, the reasoning and
 * the writing. This is a *read* copy of the memory records the phone has already
 * been shown, kept in local storage so that recall — recent, search, a single
 * record, what's due — still works on a train, in a basement, or any other time
 * the Mac isn't reachable.
 *
 * Two rules the rest of the app depends on:
 *   1. Anything served from here is labelled as coming from this phone's copy.
 *      A stale reading must never be presented as a live one.
 *   2. Nothing is *written* here that the desktop hasn't confirmed. Captures
 *      made offline stay in the outbox (see outbox.ts) and are described as held
 *      on the phone, not remembered.
 *
 * AsyncStorage, not the Keychain: these are sizeable JSON records, and
 * SecureStore values are size-limited on iOS. The mirror is dropped whenever the
 * phone is unpaired or signed out.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import type { Memory, MemoryKind } from "./types";

const STORAGE_KEY = "alfred_memory_mirror";
const ENABLED_KEY = "alfred_memory_mirror_enabled";
const VERSION = 1;

/** Bounded so a long-lived phone can't grow the mirror without limit. */
const MAX_RECORDS = 500;

interface Snapshot {
  version: number;
  syncedAt: string | null;
  records: Memory[];
}

/**
 * Search-result decoration doesn't belong in the mirror — a record cached from a
 * search hit would otherwise keep that query's score forever.
 */
function stripTransient(memory: Memory): Memory {
  const { score, via, matchedTerms, overdue, ...rest } = memory;
  return rest as Memory;
}

function newestFirst(a: Memory, b: Memory): number {
  return (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "");
}

interface MirrorState {
  hydrated: boolean;
  /** User-controlled: with this off, nothing is kept on the phone at all. */
  enabled: boolean;
  records: Record<string, Memory>;
  /** When the desktop last confirmed any part of this copy. */
  syncedAt: string | null;

  hydrate: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Record what the desktop just told us. No-op while the mirror is off. */
  put: (memories: Memory[]) => void;
  /**
   * The desktop answered, but had nothing to add. The copy is still confirmed
   * as of now — "nothing new" is a fresh reading, not a stale one.
   */
  confirm: () => void;
  drop: (ids: string[]) => void;
  clear: () => Promise<void>;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const useMirror = create<MirrorState>((set, get) => ({
  hydrated: false,
  enabled: true,
  records: {},
  syncedAt: null,

  hydrate: async () => {
    try {
      const [raw, enabledRaw] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY),
        AsyncStorage.getItem(ENABLED_KEY),
      ]);
      const enabled = enabledRaw === null ? true : enabledRaw === "true";
      const snapshot = raw ? (JSON.parse(raw) as Snapshot) : null;
      if (!snapshot || snapshot.version !== VERSION || !Array.isArray(snapshot.records)) {
        set({ hydrated: true, enabled, records: {}, syncedAt: null });
        return;
      }
      const records: Record<string, Memory> = {};
      for (const record of snapshot.records) {
        if (record && typeof record.id === "string") records[record.id] = record;
      }
      set({ hydrated: true, enabled, records, syncedAt: snapshot.syncedAt ?? null });
    } catch {
      set({ hydrated: true, records: {}, syncedAt: null });
    }
  },

  setEnabled: async (enabled) => {
    set({ enabled });
    await AsyncStorage.setItem(ENABLED_KEY, String(enabled)).catch(() => {});
    // Turning the copy off means it goes away now, not on next launch.
    if (!enabled) await get().clear();
  },

  put: (memories) => {
    if (!get().enabled || memories.length === 0) return;
    const records = { ...get().records };
    for (const memory of memories) {
      if (!memory?.id) continue;
      records[memory.id] = stripTransient(memory);
    }
    set({ records, syncedAt: new Date().toISOString() });
    schedulePersist();
  },

  confirm: () => {
    if (!get().enabled) return;
    set({ syncedAt: new Date().toISOString() });
    schedulePersist();
  },

  drop: (ids) => {
    if (ids.length === 0) return;
    const records = { ...get().records };
    let changed = false;
    for (const id of ids) {
      if (id in records) {
        delete records[id];
        changed = true;
      }
    }
    if (!changed) return;
    set({ records });
    schedulePersist();
  },

  clear: async () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    set({ records: {}, syncedAt: null });
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  },
}));

/**
 * Recall reads happen in bursts — a screen load can fold in thirty records one
 * call after another. Coalesce the writes rather than serialising the whole
 * mirror thirty times.
 */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow().catch(() => {});
  }, 500);
}

async function persistNow(): Promise<void> {
  const { enabled, records, syncedAt } = useMirror.getState();
  if (!enabled) return;
  const trimmed = Object.values(records).sort(newestFirst).slice(0, MAX_RECORDS);
  const snapshot: Snapshot = { version: VERSION, syncedAt, records: trimmed };
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn("memory mirror: could not persist", err);
  }
}

/** Non-hook accessor for the recall layer. */
export function mirrored(): Memory[] {
  return Object.values(useMirror.getState().records);
}

export function mirrorSyncedAt(): string | null {
  return useMirror.getState().syncedAt;
}

export function clearMirror(): Promise<void> {
  return useMirror.getState().clear();
}

// ---------------------------------------------------------------------------
// Reading the copy
// ---------------------------------------------------------------------------

export function localRecent(limit = 30): Memory[] {
  return mirrored().sort(newestFirst).slice(0, limit);
}

export function localMemory(id: string): Memory | null {
  return useMirror.getState().records[id] ?? null;
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

/**
 * Lexical only, and honestly labelled as such.
 *
 * The desktop searches semantically and across the graph; this can't, and
 * pretending otherwise would be the worst kind of quiet degradation. Every
 * result carries `via: "lexical"` so the screen can say where the answer came
 * from.
 */
export function localSearch(
  query: string,
  opts: { limit?: number; kinds?: MemoryKind[] } = {}
): Memory[] {
  const terms = tokenise(query);
  if (terms.length === 0) return [];

  const pool = opts.kinds?.length
    ? mirrored().filter((memory) => opts.kinds!.includes(memory.kind))
    : mirrored();

  const scored: { memory: Memory; score: number; matched: string[] }[] = [];

  for (const memory of pool) {
    const title = memory.title.toLowerCase();
    const summary = (memory.summary ?? "").toLowerCase();
    const claims = memory.assertions
      .filter((assertion) => assertion.current)
      .map((assertion) => assertion.text.toLowerCase())
      .join(" \n ");
    const labels = `${memory.entityType ?? ""} ${memory.kind}`.toLowerCase();

    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      let termScore = 0;
      if (title.includes(term)) termScore += title.startsWith(term) ? 10 : 8;
      if (summary.includes(term)) termScore += 4;
      if (claims.includes(term)) termScore += 3;
      if (labels.includes(term)) termScore += 1;
      if (termScore > 0) {
        matched.push(term);
        score += termScore;
      }
    }

    if (score === 0) continue;
    // Every word landing somewhere beats one word landing hard.
    score += matched.length === terms.length ? 6 : 0;
    scored.push({ memory, score, matched });
  }

  return scored
    .sort((a, b) => b.score - a.score || newestFirst(a.memory, b.memory))
    .slice(0, opts.limit ?? 20)
    .map(({ memory, score, matched }) => ({
      ...memory,
      score,
      via: "lexical" as const,
      matchedTerms: matched,
    }));
}

/**
 * What the mirror believes is due, computed on the phone in the phone's own
 * timezone. Snoozed items stay hidden until their snooze has run out.
 */
export function localDue(now: Date = new Date()): Memory[] {
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  return mirrored()
    .filter((memory) => {
      const reminder = memory.reminder;
      if (!reminder) return false;
      if (reminder.status === "completed" || reminder.status === "dismissed") return false;
      if (reminder.status === "snoozed") {
        if (!reminder.snoozedUntil) return false;
        if (new Date(reminder.snoozedUntil) > now) return false;
      }
      const dueAt = new Date(reminder.dueAt);
      if (Number.isNaN(dueAt.getTime())) return false;
      return dueAt <= endOfDay;
    })
    .map((memory) => ({
      ...memory,
      overdue: new Date(memory.reminder!.dueAt) < now,
    }))
    .sort((a, b) => (a.reminder!.dueAt ?? "").localeCompare(b.reminder!.dueAt ?? ""));
}

/**
 * Applied optimistically when the user completes or dismisses a reminder while
 * offline is *not* something we do — a reminder status is a write, and writes
 * belong to the Mac. This only keeps the copy honest after a write succeeds.
 */
export function applyReminderStatus(
  id: string,
  status: "completed" | "dismissed" | "snoozed" | "pending"
): void {
  const record = localMemory(id);
  if (!record?.reminder) return;
  useMirror.getState().put([{ ...record, reminder: { ...record.reminder, status } }]);
}

/** How much of the user's memory is sitting on this phone, for Settings. */
export function mirrorSize(): number {
  return Object.keys(useMirror.getState().records).length;
}
