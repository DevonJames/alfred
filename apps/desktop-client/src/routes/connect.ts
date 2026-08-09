/**
 * /connect — Desktop client identity and connectivity info
 *
 * These endpoints are intentionally unauthenticated so that Settings UI
 * (and the alfrd.net control plane) can read the desktop client's claim secret
 * and Desktop Client ID without a device token.
 *
 * The claim secret is only meaningful if the user also has physical/local
 * access to the desktop client where it is displayed — so exposing
 * it unauthenticated is safe (it provides no access by itself).
 */

import { Hono } from "hono";
import { getDesktopIdentity, readPersistedIdentity } from "../lib/cloud-connect.js";

export const connectRouter = new Hono();

/**
 * GET /connect/info
 * Returns the desktop client's alfrd.net identity info.
 * Used to show the claim code, and by the control plane during claim.
 */
connectRouter.get("/info", async (c) => {
  const persisted = await readPersistedIdentity();
  if (!persisted) {
    return c.json({ error: "not_ready" }, 503);
  }

  const { desktopClientId, cloudDesktopToken } = getDesktopIdentity();

  return c.json({
    // Local / product naming
    desktopClientId: persisted.desktopClientId ?? desktopClientId,
    claimSecret: persisted.claimSecret,
    desktopClientName: persisted.displayName ?? process.env.DESKTOP_CLIENT_NAME ?? "Alfred",
    relayConnected: !!(cloudDesktopToken || persisted.cloudDesktopToken),
    cloudUrl: process.env.ALFRD_CLOUD_URL ?? "https://api.alfrd.net",
    // Control-plane / alfred-home compatibility aliases (mobile claim UI may expect these)
    serverId: persisted.desktopClientId ?? desktopClientId,
    serverName: persisted.displayName ?? process.env.DESKTOP_CLIENT_NAME ?? "Alfred",
  });
});

/**
 * GET /connect/health
 * Lightweight check used by discovery / relay hub when probing if the desktop client is alive.
 */
connectRouter.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "alfred-desktop-client",
    timestamp: new Date().toISOString(),
  }),
);
