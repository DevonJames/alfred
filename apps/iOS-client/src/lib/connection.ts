/**
 * Connection state (PRD §8.4, §8.6).
 *
 * Holds the credentials and the currently-chosen desktop base URL. Everything
 * that talks to the desktop resolves its context from here, so a rediscovery
 * that swaps LAN for relay is picked up by the next request without any
 * component needing to know it happened.
 */
import { create } from "zustand";
import { clearMirror } from "./memory-cache";
import type { ConnectionMode } from "./types";
import { KEYS, clearCredentials, getItem, removeItem, setItem } from "./secure-store";

export interface DesktopContext {
  baseUrl: string;
  /**
   * Null until the desktop supports PIN pairing. The connectivity pass on the
   * Mac ships without local auth, so a reachable desktop with no device token
   * is a legitimate state — we just don't send an Authorization header.
   */
  deviceToken: string | null;
  /** Only sent when baseUrl is a relay path; the hub consumes it (§18.6). */
  cloudToken: string | null;
}

interface ConnectionState {
  hydrated: boolean;
  cloudToken: string | null;
  email: string | null;
  serverId: string | null;
  serverUrl: string | null;
  deviceToken: string | null;
  deviceId: string | null;
  profileId: string | null;
  mode: ConnectionMode;
  /** Human-readable reason the last probe failed, for the connection pill. */
  lastError: string | null;
  discovering: boolean;

  hydrate: () => Promise<void>;
  setCloudSession: (token: string) => Promise<void>;
  setServer: (serverId: string) => Promise<void>;
  setServerUrl: (url: string, mode: ConnectionMode) => Promise<void>;
  setDevice: (deviceId: string, deviceToken: string, profileId: string) => Promise<void>;
  setMode: (mode: ConnectionMode, lastError?: string | null) => void;
  setDiscovering: (discovering: boolean) => void;
  unpairDevice: () => Promise<void>;
  signOut: () => Promise<void>;
}

/** A relay URL carries /proxy/<serverId>; only then does the cloud token travel. */
export function isRelayUrl(url: string): boolean {
  return url.includes("/proxy/");
}

export function modeForUrl(url: string): ConnectionMode {
  if (isRelayUrl(url)) return "relay";
  return /\.local(:\d+)?(\/|$)|^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)
    ? "local"
    : "direct";
}

export const useConnection = create<ConnectionState>((set, get) => ({
  hydrated: false,
  cloudToken: null,
  email: null,
  serverId: null,
  serverUrl: null,
  deviceToken: null,
  deviceId: null,
  profileId: null,
  mode: "offline",
  lastError: null,
  discovering: false,

  hydrate: async () => {
    const [cloudToken, serverId, serverUrl, deviceToken, deviceId, profileId] = await Promise.all([
      getItem(KEYS.cloudToken),
      getItem(KEYS.cloudServerId),
      getItem(KEYS.serverUrl),
      getItem(KEYS.deviceToken),
      getItem(KEYS.deviceId),
      getItem(KEYS.profileId),
    ]);
    set({
      hydrated: true,
      cloudToken,
      serverId,
      serverUrl,
      deviceToken,
      deviceId,
      profileId,
      mode: "offline",
    });
  },

  setCloudSession: async (token) => {
    await setItem(KEYS.cloudToken, token);
    set({ cloudToken: token });
  },

  setServer: async (serverId) => {
    await setItem(KEYS.cloudServerId, serverId);
    set({ serverId });
  },

  setServerUrl: async (url, mode) => {
    const normalized = url.replace(/\/$/, "");
    await setItem(KEYS.serverUrl, normalized);
    set({ serverUrl: normalized, mode, lastError: mode === "offline" ? get().lastError : null });
  },

  setDevice: async (deviceId, deviceToken, profileId) => {
    await Promise.all([
      setItem(KEYS.deviceId, deviceId),
      setItem(KEYS.deviceToken, deviceToken),
      setItem(KEYS.profileId, profileId),
    ]);
    set({ deviceId, deviceToken, profileId });
  },

  setMode: (mode, lastError = null) => set({ mode, lastError }),
  setDiscovering: (discovering) => set({ discovering }),

  /**
   * Keep the link to the Mac; drop only this phone's desktop device credential.
   */
  unpairDevice: async () => {
    await clearMirror().catch(() => {});
    await Promise.all([
      removeItem(KEYS.deviceToken),
      removeItem(KEYS.deviceId),
      removeItem(KEYS.profileId),
      removeItem(KEYS.serverUrl),
      removeItem(KEYS.pairingDeferred),
    ]);
    set({
      deviceToken: null,
      deviceId: null,
      profileId: null,
      serverUrl: null,
      mode: "offline",
      lastError: null,
    });
  },

  signOut: async () => {
    await clearMirror().catch(() => {});
    await clearCredentials();
    set({
      cloudToken: null,
      email: null,
      serverId: null,
      serverUrl: null,
      deviceToken: null,
      deviceId: null,
      profileId: null,
      mode: "offline",
      lastError: null,
    });
  },
}));

/** Non-hook accessor for the API layer. Null until a path has been discovered. */
export function desktopContext(): DesktopContext | null {
  const { serverUrl, deviceToken, cloudToken } = useConnection.getState();
  if (!serverUrl) return null;
  return { baseUrl: serverUrl, deviceToken, cloudToken: isRelayUrl(serverUrl) ? cloudToken : null };
}
