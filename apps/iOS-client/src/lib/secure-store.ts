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
  /** Scoped link JWT from POST /servers/link (not a user account). */
  cloudToken: "alfred_cloud_token",
  cloudServerId: "alfred_cloud_server_id",
  /** @deprecated leftover account fields — cleared on sign-out */
  cloudEmail: "alfred_cloud_email",
  cloudPassword: "alfred_cloud_password",
  cloudAccountKind: "alfred_cloud_account_kind",
  serverUrl: "alfred_server_url",
  deviceToken: "alfred_device_token",
  deviceId: "alfred_device_id",
  profileId: "alfred_profile_id",
  inputMode: "alfred_input_mode",
  permissionPrimerSeen: "alfred_permission_primer_seen",
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

/** Wipe link + device credentials on sign out / reset. */
export async function clearCredentials(): Promise<void> {
  await Promise.all([
    removeItem(KEYS.cloudToken),
    removeItem(KEYS.cloudServerId),
    removeItem(KEYS.cloudEmail),
    removeItem(KEYS.cloudPassword),
    removeItem(KEYS.cloudAccountKind),
    removeItem(KEYS.serverUrl),
    removeItem(KEYS.deviceToken),
    removeItem(KEYS.deviceId),
    removeItem(KEYS.profileId),
    removeItem(KEYS.pairingDeferred),
  ]);
}

/** @deprecated use clearCredentials — no separate device account anymore */
export async function clearDeviceAccount(): Promise<void> {
  await Promise.all([
    removeItem(KEYS.cloudEmail),
    removeItem(KEYS.cloudPassword),
    removeItem(KEYS.cloudAccountKind),
  ]);
}

export const storageIsSecure = useKeychain;
