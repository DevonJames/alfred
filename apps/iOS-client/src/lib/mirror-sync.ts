/**
 * Keeping the phone's copy current (§11.3).
 *
 * memory-cache.ts only ever learns what the user happened to look at. That is a
 * poor thing to be left holding on a train: the records you need offline are
 * rarely the ones you just read. So whenever a path to the Mac appears — on
 * launch, on reconnect, on coming back to the app — the phone quietly asks for
 * the recent set and today's reminders and folds them into the copy.
 *
 * Still a read mirror, and still the desktop's word for everything. This only
 * changes *when* the phone asks, never who decides.
 */
import { AppState } from "react-native";
import { create } from "zustand";
import { useConnection } from "./connection";
import { dueReminders, recentMemories } from "./desktop-api";
import { useMirror } from "./memory-cache";

/** How much of the recent set to pull. The mirror itself caps at 500. */
const SYNC_LIMIT = 200;

/** Don't re-ask on every glance at the app. */
const MIN_INTERVAL_MS = 5 * 60_000;

interface SyncState {
  syncing: boolean;
  lastAttemptAt: number | null;
  /** Set when the last attempt failed, so Settings can be honest about it. */
  lastError: string | null;
}

export const useMirrorSync = create<SyncState>(() => ({
  syncing: false,
  lastAttemptAt: null,
  lastError: null,
}));

/**
 * Fold the desktop's recent set and due reminders into the copy.
 *
 * Silent by design: this runs in the background and a failure here changes
 * nothing the user asked for. Recall still falls back on its own, and still
 * labels what it shows. Returns how many records were folded in, or null when
 * the sync was skipped.
 */
export async function syncMirror(opts: { force?: boolean } = {}): Promise<number | null> {
  const mirror = useMirror.getState();
  if (!mirror.hydrated || !mirror.enabled) return null;

  const { serverUrl, mode } = useConnection.getState();
  if (!serverUrl || mode === "offline") return null;

  const { syncing, lastAttemptAt } = useMirrorSync.getState();
  if (syncing) return null;
  if (!opts.force && lastAttemptAt !== null && Date.now() - lastAttemptAt < MIN_INTERVAL_MS) {
    return null;
  }

  useMirrorSync.setState({ syncing: true, lastAttemptAt: Date.now() });
  try {
    // Reminders matter more than volume, but neither should sink the other:
    // a desktop build without /due can still hand over the recent set.
    const [recent, due] = await Promise.all([
      recentMemories(SYNC_LIMIT).catch(() => null),
      dueReminders().catch(() => null),
    ]);
    if (!recent && !due) throw new Error("The Mac didn't answer.");

    const records = [...(recent?.memories ?? []), ...(due?.reminders ?? [])];
    if (records.length > 0) useMirror.getState().put(records);
    else useMirror.getState().confirm();

    useMirrorSync.setState({ syncing: false, lastError: null });
    return records.length;
  } catch (err) {
    useMirrorSync.setState({ syncing: false, lastError: (err as Error).message });
    return null;
  }
}

/**
 * Sync when a path to the Mac appears, and again when the user comes back to
 * the app with one already open. Registered once from the root layout.
 */
export function watchForMirrorSync(): () => void {
  const unsubscribe = useConnection.subscribe((state, previous) => {
    const cameOnline = previous.mode === "offline" && state.mode !== "offline";
    if (cameOnline) syncMirror().catch(() => {});
  });

  const subscription = AppState.addEventListener("change", (status) => {
    if (status === "active") syncMirror().catch(() => {});
  });

  // A phone that was already connected when the app launched gets one now.
  syncMirror().catch(() => {});

  return () => {
    unsubscribe();
    subscription.remove();
  };
}
