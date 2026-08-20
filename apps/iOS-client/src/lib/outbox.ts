/**
 * Offline capture outbox (§11.3).
 *
 * The phone has no memory store of its own — everything the user tells Alfred
 * lives on their Mac. When the Mac isn't reachable, a capture is held *here*,
 * in local storage, and described as exactly that: held on this phone, not
 * remembered. It only becomes "remembered" when the desktop confirms it.
 *
 * AsyncStorage rather than the Keychain on purpose: these are notes and file
 * URIs, not credentials, and SecureStore values are size-limited on iOS.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { addMemory, addMemoryWithFiles } from "./desktop-api";
import { useConnection } from "./connection";
import { useMirror } from "./memory-cache";
import type { OutboxItem } from "./types";

const STORAGE_KEY = "alfred_capture_outbox";

export interface PendingCapture {
  text: string;
  files: { uri: string; name: string; mimeType: string }[];
}

interface OutboxState {
  items: OutboxItem[];
  flushing: boolean;
  hydrate: () => Promise<void>;
  hold: (capture: PendingCapture) => Promise<OutboxItem>;
  discard: (id: string) => Promise<void>;
  /** Try every held capture oldest-first. Returns how many landed. */
  flush: () => Promise<number>;
}

async function persist(items: OutboxItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    console.warn("outbox: could not persist", err);
  }
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `outbox-${Date.now()}-${counter}`;
}

export const useOutbox = create<OutboxState>((set, get) => ({
  items: [],
  flushing: false,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const items = raw ? (JSON.parse(raw) as OutboxItem[]) : [];
      set({ items: Array.isArray(items) ? items : [] });
    } catch {
      set({ items: [] });
    }
  },

  hold: async (capture) => {
    const item: OutboxItem = {
      id: nextId(),
      text: capture.text,
      createdAt: new Date().toISOString(),
      files: capture.files,
      attempts: 0,
      lastError: null,
    };
    const items = [...get().items, item];
    set({ items });
    await persist(items);
    return item;
  },

  discard: async (id) => {
    const items = get().items.filter((item) => item.id !== id);
    set({ items });
    await persist(items);
  },

  flush: async () => {
    if (get().flushing) return 0;
    const queued = get().items;
    if (queued.length === 0) return 0;

    set({ flushing: true });
    let delivered = 0;
    const remaining: OutboxItem[] = [];

    try {
      for (const item of queued) {
        try {
          const result =
            item.files.length > 0
              ? await addMemoryWithFiles(item.text, item.files)
              : await addMemory(item.text);
          // Now that the desktop owns it, it can join the phone's read copy.
          useMirror.getState().put([result.memory]);
          delivered += 1;
        } catch (err) {
          // Held, not lost. The user is told it's still on the phone.
          remaining.push({
            ...item,
            attempts: item.attempts + 1,
            lastError: (err as Error).message,
          });
        }
      }
      set({ items: remaining });
      await persist(remaining);
      return delivered;
    } finally {
      set({ flushing: false });
    }
  },
}));

/**
 * Flush whenever a path to the Mac appears. Registered once from the root
 * layout; the subscription lives for the life of the app.
 */
export function watchConnectionForFlush(): () => void {
  return useConnection.subscribe((state, previous) => {
    const cameOnline = previous.mode === "offline" && state.mode !== "offline";
    if (cameOnline && useOutbox.getState().items.length > 0) {
      useOutbox.getState().flush().catch(() => {});
    }
  });
}
