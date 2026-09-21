import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ConnectionMode = "lan" | "wan" | "relay" | "offline";

export interface AlfredBotStore {
  botId: string | null;
  cloudToken: string | null;
  cloudServerId: string | null;
  desktopName: string | null;
  serverUrl: string | null;
  connectionType: ConnectionMode | null;
  deviceToken: string | null;
  deviceId: string | null;
  /** iPhone can flip this: local speakers/mic vs phone-as-audio. */
  audioSource?: "phone" | "local" | null;
}

const EMPTY: AlfredBotStore = {
  botId: null,
  cloudToken: null,
  cloudServerId: null,
  desktopName: null,
  serverUrl: null,
  connectionType: null,
  deviceToken: null,
  deviceId: null,
  audioSource: null,
};

function storePath(): string {
  const override = process.env.ALFREDBOT_STORE_PATH;
  if (override) return resolve(override);
  return resolve(process.cwd(), "../../data/alfredbot/identity.json");
}

export async function loadStore(): Promise<AlfredBotStore> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AlfredBotStore>;
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveStore(next: AlfredBotStore): Promise<AlfredBotStore> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function patchStore(patch: Partial<AlfredBotStore>): Promise<AlfredBotStore> {
  const current = await loadStore();
  return saveStore({ ...current, ...patch });
}

export async function clearStore(): Promise<AlfredBotStore> {
  const current = await loadStore();
  return saveStore({ ...EMPTY, botId: current.botId });
}

export function isPaired(store: AlfredBotStore): boolean {
  return Boolean(store.cloudToken && store.cloudServerId && store.serverUrl && store.deviceToken);
}
