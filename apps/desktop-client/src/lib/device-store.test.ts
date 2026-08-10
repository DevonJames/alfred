import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  confirmDevicePair,
  createPendingDevice,
  deleteDevice,
  findDeviceByToken,
  listDevices,
} from "./device-store.js";

describe("device-store pairing", () => {
  let dir: string;
  let prevPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "alfred-devices-"));
    prevPath = process.env.ALFRED_DESKTOP_DEVICES_PATH;
    process.env.ALFRED_DESKTOP_DEVICES_PATH = join(dir, "devices.json");
  });

  afterEach(async () => {
    if (prevPath === undefined) delete process.env.ALFRED_DESKTOP_DEVICES_PATH;
    else process.env.ALFRED_DESKTOP_DEVICES_PATH = prevPath;
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a pending device with PIN and confirms with correct PIN", async () => {
    const { device, expiresInSeconds } = await createPendingDevice({
      name: "Devon’s iPhone",
      deviceType: "ios",
    });
    expect(device.isPaired).toBe(false);
    expect(device.pairingPin).toMatch(/^\d{6}$/);
    expect(expiresInSeconds).toBe(300);
    expect((await listDevices()).length).toBe(1);

    const wrongPin = device.pairingPin === "000000" ? "000001" : "000000";
    const bad = await confirmDevicePair(device.id, wrongPin);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("invalid_pin");

    const ok = await confirmDevicePair(device.id, device.pairingPin!);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.device.isPaired).toBe(true);
    expect(ok.device.pairingPin).toBeNull();

    const byToken = await findDeviceByToken(ok.device.token);
    expect(byToken?.id).toBe(device.id);

    // Idempotent confirm
    const again = await confirmDevicePair(device.id, "999999");
    expect(again.ok).toBe(true);
  });

  it("rejects expired PIN", async () => {
    const { device } = await createPendingDevice({ name: "Test" });
    // Force expiry via confirm after mutating file through confirm path:
    // recreate with past expiry by confirming invalid then manually...
    // Use confirm with wrong pin then delete and recreate with patched store.
    const { replaceAllDevices } = await import("./device-store.js");
    await replaceAllDevices([
      {
        ...device,
        pairingExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    const result = await confirmDevicePair(device.id, device.pairingPin!);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("expired");
  });

  it("deletes devices on unpair", async () => {
    const { device } = await createPendingDevice({ name: "Gone" });
    expect(await deleteDevice(device.id)).toBe(true);
    expect(await listDevices()).toEqual([]);
    expect(await deleteDevice(device.id)).toBe(false);
  });
});
