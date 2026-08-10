import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { extractBearerToken } from "../lib/device-auth.js";
import {
  findDeviceByToken,
  touchDevice,
  type DeviceRecord,
} from "../lib/device-store.js";

export type DeviceVariables = {
  device: DeviceRecord;
};

export const requireDevice = createMiddleware<{ Variables: DeviceVariables }>(
  async (c, next) => {
    const token =
      extractBearerToken(c.req.header("Authorization")) ??
      c.req.query("token") ??
      null;

    if (!token) {
      return c.json({ detail: "Missing device bearer token" }, 401);
    }

    const device = await findDeviceByToken(token);
    if (!device) {
      return c.json({ detail: "Invalid device token" }, 401);
    }
    if (!device.isPaired) {
      return c.json({ detail: "Device is not paired" }, 401);
    }

    await touchDevice(device.id);
    c.set("device", device);
    await next();
  },
);

/** Optional auth: attaches device when bearer present, otherwise continues. */
export async function optionalDevice(c: Context, next: Next): Promise<Response | void> {
  const token =
    extractBearerToken(c.req.header("Authorization")) ?? c.req.query("token") ?? null;
  if (token) {
    const device = await findDeviceByToken(token);
    if (device?.isPaired) {
      await touchDevice(device.id);
      c.set("device", device);
    }
  }
  await next();
}
