/**
 * Device PIN pairing — alfred-home compatible contract.
 *
 * POST /pair/request  → pending device + PIN (shown on Mac)
 * POST /pair/confirm  → device bearer token
 * DELETE /pair/:id    → unpair
 * GET /pair/devices   → list (PIN only for unpaired) for claim UI
 */

import { Hono } from "hono";
import { readPersistedIdentity } from "../lib/cloud-connect.js";
import {
  confirmDevicePair,
  createPendingDevice,
  deleteDevice,
  listDevices,
} from "../lib/device-store.js";

export const pairRouter = new Hono();

pairRouter.post("/request", async (c) => {
  let body: {
    device?: { name?: string; device_type?: string; app_version?: string };
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ detail: "Invalid JSON body" }, 400);
  }

  const name = body.device?.name?.trim();
  if (!name) {
    return c.json({ detail: "device.name is required" }, 400);
  }

  const { device, expiresInSeconds } = await createPendingDevice({
    name,
    deviceType: body.device?.device_type,
    appVersion: body.device?.app_version,
  });

  console.log(
    `[Pair] PIN for "${device.name}": ${device.pairingPin} (expires ${expiresInSeconds}s) device_id=${device.id}`,
  );

  return c.json({
    device_id: device.id,
    pin: device.pairingPin,
    expires_in_seconds: expiresInSeconds,
    auto_paired: false,
  });
});

pairRouter.post("/confirm", async (c) => {
  let body: { device_id?: string; pin?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ detail: "Invalid JSON body" }, 400);
  }

  const deviceId = body.device_id?.trim();
  const pin = body.pin?.trim();
  if (!deviceId || !pin || pin.length !== 6) {
    return c.json({ detail: "device_id and 6-digit pin are required" }, 400);
  }

  const result = await confirmDevicePair(deviceId, pin);
  if (!result.ok) {
    if (result.error === "not_found") {
      return c.json({ detail: "Device not found" }, 404);
    }
    if (result.error === "expired") {
      return c.json({ detail: "PIN has expired" }, 400);
    }
    return c.json({ detail: "Invalid PIN" }, 400);
  }

  const identity = await readPersistedIdentity();
  const serverId = identity?.desktopClientId ?? "alfred-desktop";
  const serverName =
    identity?.displayName ?? process.env.DESKTOP_CLIENT_NAME ?? "Alfred";

  console.log(`[Pair] Device paired: ${result.device.name} (${result.device.id})`);

  return c.json({
    device_id: result.device.id,
    token: result.device.token,
    server_name: serverName,
    server_id: serverId,
  });
});

pairRouter.get("/devices", async (c) => {
  const devices = await listDevices();
  return c.json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      device_type: d.deviceType,
      app_version: d.appVersion,
      is_paired: d.isPaired,
      pairing_pin: d.isPaired ? undefined : d.pairingPin,
      pairing_expires_at: d.isPaired ? undefined : d.pairingExpiresAt,
      pairing_expired:
        d.pairingExpiresAt != null
          ? new Date(d.pairingExpiresAt) < new Date()
          : undefined,
      created_at: d.createdAt,
      last_seen_at: d.lastSeenAt,
    })),
  });
});

pairRouter.delete("/:device_id", async (c) => {
  const deviceId = c.req.param("device_id");
  const removed = await deleteDevice(deviceId);
  if (!removed) {
    return c.json({ detail: "Device not found" }, 404);
  }
  return c.json({ status: "unpaired", device_id: deviceId });
});
