/**
 * Credential storage (PRD §8.2).
 *
 * Keychain-backed on device. On web — where SecureStore has no implementation —
 * we fall back to AsyncStorage so the preview still runs, and say so out loud,
 * because that fallback is NOT a secure store.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const KEYS = {
  cloudToken: "alfred_cloud_token",
  cloudServerId: "alfred_cloud_server_id",
  /**
   * The control plane only issues claim tokens to an account, so the app makes
   * one for this phone and keeps the credentials here. The user never types
   * them — see cloud-identity.ts. `cloudAccountKind` records whether the
   * session came from that device account or from a real alfrd.net sign-in.
   */
  cloudEmail: "alfred_cloud_email",
  cloudPassword: "alfred_cloud_password",
  cloudAccountKind: "alfred_cloud_account_kind",
  serverUrl: "alfred_server_url",
  deviceToken: "alfred_device_token",
  deviceId: "alfred_device_id",
  profileId: "alfred_profile_id",
  /** Local UX preferences — not credentials. */
  inputMode: "alfred_input_mode",
  permissionPrimerSeen: "alfred_permission_primer_seen",
  /** Set when the desktop's build has no PIN pairing yet (see §8.5 follow-ons). */
  pairingDeferred: "alfred_pairing_deferred",
} as const;

export type StorageKey = (typeof KEYS)[keyof typeof KEYS];

const useKeychain = Platform.OS !== "web";

export async function getItem(key: StorageKey): Promise<string | null> {
  try {
    return useKeychain ? await SecureStore.getItemAsync(key) : await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setItem(key: StorageKey, value: string): Promise<void> {
  try {
    if (useKeychain) await SecureStore.setItemAsync(key, value);
    else await AsyncStorage.setItem(key, value);
  } catch (err) {
    console.warn(`secure-store: could not persist ${key}`, err);
  }
}

export async function removeItem(key: StorageKey): Promise<void> {
  try {
    if (useKeychain) await SecureStore.deleteItemAsync(key);
    else await AsyncStorage.removeItem(key);
  } catch {
    /* nothing to remove */
  }
}

/**
 * Wipe the session on sign out / unpair (§10.5).
 *
 * The device account itself survives on purpose: it is the only thing that can
 * re-claim a Mac this phone already claimed, and regenerating it would earn a
 * `409 already claimed` from the control plane. Use `clearDeviceAccount` for a
 * genuine reset.
 */
export async function clearCredentials(): Promise<void> {
  await Promise.all([
    removeItem(KEYS.cloudToken),
    removeItem(KEYS.cloudServerId),
    removeItem(KEYS.serverUrl),
    removeItem(KEYS.deviceToken),
    removeItem(KEYS.deviceId),
    removeItem(KEYS.profileId),
    removeItem(KEYS.pairingDeferred),
  ]);
}

/** A true reset: forget the phone's own alfrd.net identity as well. */
export async function clearDeviceAccount(): Promise<void> {
  await Promise.all([
    removeItem(KEYS.cloudEmail),
    removeItem(KEYS.cloudPassword),
    removeItem(KEYS.cloudAccountKind),
  ]);
}

export const storageIsSecure = useKeychain;
