import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { buildBotUri, type BotClaimPayload } from "../lib/bot-qr.js";
import { loadStore, patchStore } from "./store.js";

const SESSION_TTL_MS = 30 * 60 * 1000;

let session: { id: string; createdAt: number } | null = null;

export function listenPort(): number {
  return Number.parseInt(process.env.ALFREDBOT_PORT ?? "3200", 10);
}

export function deviceName(): string {
  return process.env.ALFREDBOT_DEVICE_NAME?.trim() || "AlfredBot";
}

export function lanHosts(port = listenPort()): string[] {
  const hosts: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      const family = String(net.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (net.internal) continue;
      hosts.push(`http://${net.address}:${port}`);
    }
  }
  return hosts;
}

export function currentSession(): string {
  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
    session = { id: randomUUID(), createdAt: Date.now() };
  }
  return session.id;
}

export function rotateSession(): string {
  session = { id: randomUUID(), createdAt: Date.now() };
  return session.id;
}

export function sessionMatches(value: string | undefined): boolean {
  return Boolean(value && session && value === session.id);
}

export async function botId(): Promise<string> {
  const store = await loadStore();
  if (store.botId) return store.botId;
  const id = randomUUID();
  await patchStore({ botId: id });
  return id;
}

export async function identityPayload(): Promise<BotClaimPayload> {
  const hosts = lanHosts();
  return {
    botId: await botId(),
    session: currentSession(),
    hosts: hosts.length > 0 ? hosts : [`http://127.0.0.1:${listenPort()}`],
    name: deviceName(),
  };
}

export async function identityCard(): Promise<{
  botId: string;
  session: string;
  name: string;
  hosts: string[];
  uri: string;
}> {
  const payload = await identityPayload();
  return {
    ...payload,
    name: payload.name ?? deviceName(),
    uri: buildBotUri(payload),
  };
}
