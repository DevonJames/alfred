/**
 * cloud-connect.ts
 *
 * Handles the Alfred desktop client's connection to the alfrd.net control plane:
 *   1. Generates a stable desktopClientId (UUID) on first run, persisted on disk.
 *   2. Generates a claimSecret (8-char alphanumeric) for the user to link their account.
 *   3. Registers with the control plane (POST /servers/register) — remote API still
 *      uses serverId / claimSecret field names.
 *   4. Detects LAN and WAN IP addresses and keeps connection candidates updated.
 *   5. Maintains a persistent outbound WebSocket tunnel to the relay hub.
 *      The relay hub proxies HTTP requests from mobile clients through this tunnel.
 */

import { networkInterfaces } from "node:os";
import { v4 as uuidv4 } from "uuid";
import {
  loadIdentity,
  saveIdentity,
  updateIdentity,
  type DesktopClientIdentity,
} from "./identity-store.js";

const CLOUD_URL = process.env.ALFRD_CLOUD_URL ?? "https://api.alfrd.net";
const RELAY_WS_URL = process.env.ALFRD_RELAY_URL ?? "wss://api.alfrd.net";

// Reconnect delay schedule (ms): 5s, 10s, 30s, 60s, 120s cap
const RECONNECT_DELAYS = [5_000, 10_000, 30_000, 60_000, 120_000];
/** App-level ping so idle proxies do not silently drop the relay tunnel. */
const RELAY_PING_MS = 25_000;
/** Refresh LAN/WAN candidates + desktop token periodically. */
const REREGISTER_MS = 15 * 60_000;

let currentSocket: WebSocket | null = null;
let reconnectAttempt = 0;
let isShuttingDown = false;
let currentDesktopClientId: string | null = null;
let currentCloudDesktopToken: string | null = null;
let relayListenPort = 3000;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reregisterTimer: ReturnType<typeof setInterval> | null = null;
let claimSecretCached: string | null = null;
let displayNameCached = "Alfred";

function generateClaimSecret(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function getOrCreateDesktopIdentity(): Promise<{
  serverId: string;
  claimSecret: string;
  serverToken: string | null;
  displayName: string;
}> {
  let identity = await loadIdentity();

  if (!identity) {
    identity = {
      desktopClientId: uuidv4(),
      claimSecret: generateClaimSecret(),
      cloudDesktopToken: null,
      displayName: process.env.DESKTOP_CLIENT_NAME ?? "Alfred",
    };
    await saveIdentity(identity);
    return {
      serverId: identity.desktopClientId,
      claimSecret: identity.claimSecret,
      serverToken: null,
      displayName: identity.displayName,
    };
  }

  let changed = false;
  if (!identity.desktopClientId) {
    identity.desktopClientId = uuidv4();
    changed = true;
  }
  if (!identity.claimSecret) {
    identity.claimSecret = generateClaimSecret();
    changed = true;
  }
  if (!identity.displayName) {
    identity.displayName = process.env.DESKTOP_CLIENT_NAME ?? "Alfred";
    changed = true;
  }
  if (changed) {
    await saveIdentity(identity);
  }

  return {
    serverId: identity.desktopClientId,
    claimSecret: identity.claimSecret,
    serverToken: identity.cloudDesktopToken,
    displayName: identity.displayName,
  };
}

async function detectLanIp(): Promise<string | null> {
  try {
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      if (name.toLowerCase().includes("loopback") || name.toLowerCase() === "lo") continue;
      for (const iface of ifaces[name] ?? []) {
        const isV4 = iface.family === "IPv4" || (iface.family as unknown) === 4;
        if (isV4 && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function detectWanIp(): Promise<string | null> {
  try {
    const resp = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const { ip } = (await resp.json()) as { ip: string };
      return ip;
    }
  } catch {
    // ignore — WAN detection is best-effort
  }
  return null;
}

async function registerWithControlPlane(
  serverId: string,
  claimSecret: string,
  serverPort: number,
  displayName: string,
): Promise<string | null> {
  const [lanIp, wanIp] = await Promise.all([detectLanIp(), detectWanIp()]);

  const candidates: Array<{ type: string; url: string; priority: number }> = [];

  if (lanIp) {
    candidates.push({
      type: "lan",
      url: `http://${lanIp}:${serverPort}`,
      priority: 10,
    });
  }
  if (wanIp) {
    candidates.push({
      type: "wan",
      url: `http://${wanIp}:${serverPort}`,
      priority: 20,
    });
  }
  // Relay is always the last-resort fallback
  candidates.push({
    type: "relay",
    url: `${CLOUD_URL}/proxy/${serverId}`,
    priority: 100,
  });

  try {
    const resp = await fetch(`${CLOUD_URL}/servers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId,
        claimSecret,
        name: process.env.DESKTOP_CLIENT_NAME ?? displayName ?? "Alfred",
        connectionCandidates: candidates,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      console.error(`[CloudConnect] Registration failed: ${resp.status} ${await resp.text()}`);
      return null;
    }

    const { token } = (await resp.json()) as { serverId: string; token: string };

    await updateIdentity({ cloudDesktopToken: token });

    return token;
  } catch (err) {
    console.error("[CloudConnect] Registration error:", err);
    return null;
  }
}

function clearPingTimer() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function startPing(ws: WebSocket) {
  clearPingTimer();
  pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "ping", atMs: Date.now() }));
    } catch {
      /* close handler will reconnect */
    }
  }, RELAY_PING_MS);
}

function connectRelayTunnel(serverId: string, serverToken: string) {
  if (isShuttingDown) return;

  const wsUrl = `${RELAY_WS_URL}/relay/server/${serverId}?token=${encodeURIComponent(serverToken)}`;
  console.log(`[CloudConnect] Connecting tunnel to relay...`);

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error("[CloudConnect] Failed to create WebSocket:", err);
    scheduleReconnect(serverId, serverToken);
    return;
  }

  currentSocket = ws;

  ws.addEventListener("open", () => {
    console.log(`[CloudConnect] Relay tunnel established (desktopClientId: ${serverId})`);
    reconnectAttempt = 0;
    currentCloudDesktopToken = serverToken;
    startPing(ws);
  });

  ws.addEventListener("message", async (event) => {
    let msg: {
      type: string;
      requestId?: string;
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: string | null;
    };
    try {
      const data =
        typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString();
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === "pong" || msg.type === "ping") {
      return;
    }

    if (msg.type === "request" && msg.requestId) {
      await handleRelayRequest(
        ws,
        msg.requestId,
        msg.method!,
        msg.path!,
        msg.headers ?? {},
        msg.body ?? null,
      );
    }
  });

  ws.addEventListener("close", (event) => {
    console.log(`[CloudConnect] Relay tunnel closed (code: ${event.code})`);
    clearPingTimer();
    currentSocket = null;
    if (!isShuttingDown) {
      scheduleReconnect(serverId, serverToken);
    }
  });

  ws.addEventListener("error", (err) => {
    console.error("[CloudConnect] Relay tunnel error:", err);
  });
}

async function handleRelayRequest(
  ws: WebSocket,
  requestId: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | null,
) {
  const serverPort = relayListenPort;
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  // Strip /proxy/:serverId prefix if somehow included
  const cleanPath = path.startsWith("/proxy/") ? path.replace(/^\/proxy\/[^/]+/, "") : path;

  try {
    const resp = await fetch(`${baseUrl}${cleanPath}`, {
      method,
      headers: {
        ...headers,
        host: `127.0.0.1:${serverPort}`,
      },
      body: body && !["GET", "HEAD", "DELETE"].includes(method.toUpperCase()) ? body : undefined,
      signal: AbortSignal.timeout(25_000),
    });

    const responseBody = await resp.text();
    const responseHeaders: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      // Skip hop-by-hop headers
      if (!["connection", "transfer-encoding", "keep-alive"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    ws.send(
      JSON.stringify({
        type: "response",
        requestId,
        status: resp.status,
        headers: responseHeaders,
        body: responseBody,
      }),
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: "response",
        requestId,
        status: 502,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "relay_local_error", message: String(err) }),
      }),
    );
  }
}

function scheduleReconnect(serverId: string, serverToken: string) {
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
  reconnectAttempt++;
  console.log(`[CloudConnect] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})...`);
  setTimeout(() => {
    void (async () => {
      // After repeated drops (or overnight sleep), refresh token + LAN candidates
      // before opening the socket again — stale tokens never recover without restart.
      if (reconnectAttempt >= 2 && claimSecretCached) {
        const fresh = await registerWithControlPlane(
          serverId,
          claimSecretCached,
          relayListenPort,
          displayNameCached,
        );
        if (fresh) {
          currentCloudDesktopToken = fresh;
          connectRelayTunnel(serverId, fresh);
          return;
        }
      }
      connectRelayTunnel(serverId, currentCloudDesktopToken ?? serverToken);
    })();
  }, delay);
}

async function ensureRegisteredAndTunneled(): Promise<void> {
  if (isShuttingDown || !currentDesktopClientId || !claimSecretCached) return;

  const token = await registerWithControlPlane(
    currentDesktopClientId,
    claimSecretCached,
    relayListenPort,
    displayNameCached,
  );
  if (!token) {
    console.warn("[CloudConnect] Registration failed — will retry");
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
    reconnectAttempt++;
    setTimeout(() => void ensureRegisteredAndTunneled(), delay);
    return;
  }

  currentCloudDesktopToken = token;
  console.log(`[CloudConnect] Registered with control plane`);

  if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
    connectRelayTunnel(currentDesktopClientId, token);
  }
}

export async function startCloudConnect(serverPort = 3000) {
  if (process.env.ALFRD_CLOUD_DISABLED === "true") {
    console.log("[CloudConnect] Disabled via ALFRD_CLOUD_DISABLED=true");
    return;
  }

  relayListenPort = serverPort;

  let identity: Awaited<ReturnType<typeof getOrCreateDesktopIdentity>>;
  try {
    identity = await getOrCreateDesktopIdentity();
  } catch (err) {
    console.error("[CloudConnect] Could not get desktop client identity:", err);
    return;
  }

  const { serverId, claimSecret, displayName } = identity;
  currentDesktopClientId = serverId;
  claimSecretCached = claimSecret;
  displayNameCached = displayName;

  console.log(`[CloudConnect] Desktop Client ID: ${serverId}`);
  console.log(`[CloudConnect] Claim secret: ${claimSecret}`);
  console.log(`[CloudConnect] Claim QR page: http://127.0.0.1:${serverPort}/connect/claim`);

  await ensureRegisteredAndTunneled();

  if (reregisterTimer) clearInterval(reregisterTimer);
  reregisterTimer = setInterval(() => {
    void ensureRegisteredAndTunneled();
  }, REREGISTER_MS);
}

export function stopCloudConnect() {
  isShuttingDown = true;
  clearPingTimer();
  if (reregisterTimer) {
    clearInterval(reregisterTimer);
    reregisterTimer = null;
  }
  currentSocket?.close(1000, "Shutdown");
}

/** Remote-protocol fields (serverId) plus local token state for /connect/info. */
export function getDesktopIdentity() {
  return {
    desktopClientId: currentDesktopClientId,
    cloudDesktopToken: currentCloudDesktopToken,
    /** Alias for control-plane / alfred-home naming compatibility */
    serverId: currentDesktopClientId,
    serverToken: currentCloudDesktopToken,
  };
}

export async function readPersistedIdentity(): Promise<DesktopClientIdentity | null> {
  return loadIdentity();
}
