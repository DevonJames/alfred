import { desktopFetch, discoverServer } from "./discovery.js";
import { loadStore, patchStore, type AlfredBotStore } from "./store.js";

/** iPhone Talk can ping the robot directly. Desktop flag is the backup. */
let listenWanted = false;
let desktopOn = false;
let desktopId = 0;

export function setTalkListen(on: boolean): void {
  listenWanted = on;
}

export function conversationSnapshot(): { conversation: boolean; conversationId: number } {
  return {
    conversation: listenWanted || desktopOn,
    conversationId: desktopId,
  };
}

export async function refreshDesktopConversation(store: AlfredBotStore): Promise<void> {
  if (!store.serverUrl || !store.deviceToken) return;
  try {
    const res = await desktopFetch(
      store.serverUrl,
      store.cloudToken,
      store.deviceToken,
      "/api/session/status",
      { timeoutMs: 2_500 },
    );
    if (!res.ok) return;
    const body = (await res.json()) as { conversation?: unknown; conversationId?: unknown };
    const nextOn = body.conversation === true;
    const nextId = typeof body.conversationId === "number" ? body.conversationId : desktopId;
    if (nextOn !== desktopOn || nextId !== desktopId) {
      console.log(`[alfredbot] conversation ${desktopOn}#${desktopId} → ${nextOn}#${nextId}`);
    }
    desktopOn = nextOn;
    desktopId = nextId;
  } catch {
    /* keep the last snapshot so /api/status stays instant */
  }
}

async function preferLan(store: AlfredBotStore): Promise<void> {
  if (!store.cloudServerId || !store.cloudToken || store.connectionType === "lan") return;
  try {
    const found = await discoverServer(store.cloudServerId, store.cloudToken);
    if (found.mode !== "lan" || found.url === store.serverUrl) return;
    await patchStore({ serverUrl: found.url, connectionType: found.mode });
    console.log(`[alfredbot] desktop path ${store.connectionType} → ${found.mode} ${found.url}`);
  } catch {
    /* stay on the current URL */
  }
}

/** Status must not wait on relay. Refresh conversation in the background. */
export function startConversationWatch(): void {
  let busy = false;
  let lastLanCheck = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const store = await loadStore();
      await refreshDesktopConversation(store);
      const now = Date.now();
      if (now - lastLanCheck > 20_000) {
        lastLanCheck = now;
        await preferLan(store);
      }
    } finally {
      busy = false;
    }
  };
  void tick();
  setInterval(() => void tick(), 400);
}
