import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "node:crypto";
import { requireDevice } from "./require-device.js";
import { coreSecret, isSidecarMode } from "../lib/sidecar-mode.js";

function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Device PIN auth, or shared internal secret when running as alfred-home sidecar. */
export const requireSidecarOrDevice = createMiddleware(async (c, next) => {
  if (!isSidecarMode()) {
    return requireDevice(c, next);
  }

  const secret = coreSecret();
  if (!secret) {
    return c.json({ error: "ALFRED_CORE_SECRET is not configured" }, 503);
  }
  const provided = c.req.header("x-internal-secret") ?? "";
  if (!provided || !safeEquals(provided, secret)) {
    return c.json({ error: "Unauthorized sidecar request" }, 401);
  }
  await next();
});
