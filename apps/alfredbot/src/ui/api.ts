export type ScreenId = "wifi" | "claim" | "pin" | "face";

export interface BootState {
  screen: ScreenId;
  wifi: { connected: boolean; ssid: string | null; online: boolean; mock: boolean };
  paired: boolean;
  connectionType: "lan" | "wan" | "relay" | "offline" | null;
  desktopName: string | null;
  serverUrl: string | null;
  deviceId: string | null;
  audioSource?: "phone" | "local";
  /** iPhone asked the face to join LiveKit for this conversation. */
  conversation?: boolean;
  /** Increments on each Talk start so the face rematches a new agent. */
  conversationId?: number;
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  secure: boolean;
  active: boolean;
}

export interface SessionToken {
  url: string;
  room: string;
  identity: string;
  token: string;
  voiceStack?: "live" | "cascade";
  error?: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers });
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = { error: raw };
  }
  if (!res.ok) {
    const body = parsed as { error?: string; detail?: string } | null;
    throw new Error(body?.error ?? body?.detail ?? `Request failed (${res.status})`);
  }
  return parsed as T;
}

export interface BotIdentity {
  botId: string;
  session: string;
  name: string;
  hosts: string[];
  uri: string;
}

export const api = {
  status: () => request<BootState>("/api/status"),
  identity: () => request<BotIdentity>("/api/identity"),
  scanWifi: () => request<{ networks: WifiNetwork[] }>("/api/wifi/scan", { method: "POST" }),
  joinWifi: (ssid: string, password: string) =>
    request<{ wifi: BootState["wifi"]; screen: ScreenId }>("/api/wifi/join", {
      method: "POST",
      body: JSON.stringify({ ssid, password }),
    }),
  claim: (input: { raw?: string; serverId?: string; claimSecret?: string }) =>
    request<{ ok: boolean; screen: ScreenId; desktopName?: string; connectionType?: string }>(
      "/api/claim",
      { method: "POST", body: JSON.stringify(input) },
    ),
  requestPin: () =>
    request<{ device_id: string; expires_in_seconds: number }>("/api/pair/request", {
      method: "POST",
    }),
  confirmPin: (pin: string, deviceId?: string) =>
    request<{ ok: boolean; screen: ScreenId; desktopName?: string }>("/api/pair/confirm", {
      method: "POST",
      body: JSON.stringify({ pin, device_id: deviceId }),
    }),
  unpair: () => request<BootState>("/api/unpair", { method: "POST" }),
  talkToken: () => request<SessionToken>("/api/talk/token", { method: "POST" }),
  talkStart: () => request<{ ok: boolean; conversation: boolean }>("/api/talk/start", { method: "POST" }),
  talkHangup: () => request<{ ok: boolean; conversation: boolean }>("/api/talk/hangup", { method: "POST" }),
  talkStop: () => request<{ ok: boolean; conversation: boolean }>("/api/talk/stop", { method: "POST" }),
  talkStatus: () =>
    request<{ voiceStack?: string; agentPresent?: boolean; agentHint?: string | null }>(
      "/api/talk/status",
    ),
};
