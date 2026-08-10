/**
 * Filesystem-backed paired device store for desktop PIN pairing.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import {
  expiresInSeconds,
  generateDeviceToken,
  generatePin,
  getPairingExpiresAt,
} from "./device-auth.js";

export interface DeviceRecord {
  id: string;
  name: string;
  token: string;
  pairingPin: string | null;
  pairingExpiresAt: string | null;
  isPaired: boolean;
  deviceType: string | null;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string;
}

interface DeviceFile {
  devices: DeviceRecord[];
}

function devicesPath(): string {
  const override = process.env.ALFRED_DESKTOP_DEVICES_PATH;
  if (override) return resolve(override);
  return resolve(process.cwd(), "../../data/desktop-client/devices.json");
}

async function loadFile(): Promise<DeviceFile> {
  try {
    const raw = await readFile(devicesPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeviceFile>;
    return { devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { devices: [] };
    throw err;
  }
}

async function saveFile(file: DeviceFile): Promise<void> {
  const path = devicesPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export async function listDevices(): Promise<DeviceRecord[]> {
  const file = await loadFile();
  return file.devices;
}

export async function findDeviceById(id: string): Promise<DeviceRecord | null> {
  const file = await loadFile();
  return file.devices.find((d) => d.id === id) ?? null;
}

export async function findDeviceByToken(token: string): Promise<DeviceRecord | null> {
  const file = await loadFile();
  return file.devices.find((d) => d.token === token) ?? null;
}

export async function createPendingDevice(input: {
  name: string;
  deviceType?: string;
  appVersion?: string;
}): Promise<{ device: DeviceRecord; expiresInSeconds: number }> {
  const now = new Date().toISOString();
  const device: DeviceRecord = {
    id: uuidv4(),
    name: input.name,
    token: generateDeviceToken(),
    pairingPin: generatePin(),
    pairingExpiresAt: getPairingExpiresAt(),
    isPaired: false,
    deviceType: input.deviceType ?? null,
    appVersion: input.appVersion ?? null,
    createdAt: now,
    lastSeenAt: now,
  };

  const file = await loadFile();
  file.devices.push(device);
  await saveFile(file);

  return { device, expiresInSeconds: expiresInSeconds() };
}

export async function confirmDevicePair(
  deviceId: string,
  pin: string,
): Promise<
  | { ok: true; device: DeviceRecord }
  | { ok: false; error: "not_found" | "invalid_pin" | "expired" }
> {
  const file = await loadFile();
  const idx = file.devices.findIndex((d) => d.id === deviceId);
  if (idx < 0) return { ok: false, error: "not_found" };
  const device = file.devices[idx]!;

  if (device.isPaired) {
    return { ok: true, device };
  }

  if (!device.pairingPin || device.pairingPin !== pin) {
    return { ok: false, error: "invalid_pin" };
  }
  if (!device.pairingExpiresAt || new Date(device.pairingExpiresAt) < new Date()) {
    return { ok: false, error: "expired" };
  }

  const now = new Date().toISOString();
  const next: DeviceRecord = {
    ...device,
    isPaired: true,
    pairingPin: null,
    pairingExpiresAt: null,
    lastSeenAt: now,
  };
  file.devices[idx] = next;
  await saveFile(file);
  return { ok: true, device: next };
}

export async function touchDevice(deviceId: string): Promise<void> {
  const file = await loadFile();
  const idx = file.devices.findIndex((d) => d.id === deviceId);
  if (idx < 0) return;
  file.devices[idx] = {
    ...file.devices[idx]!,
    lastSeenAt: new Date().toISOString(),
  };
  await saveFile(file);
}

export async function deleteDevice(deviceId: string): Promise<boolean> {
  const file = await loadFile();
  const before = file.devices.length;
  file.devices = file.devices.filter((d) => d.id !== deviceId);
  if (file.devices.length === before) return false;
  await saveFile(file);
  return true;
}

/** Test helper: overwrite store path contents. */
export async function replaceAllDevices(devices: DeviceRecord[]): Promise<void> {
  await saveFile({ devices });
}
