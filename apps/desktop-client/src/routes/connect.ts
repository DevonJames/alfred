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
import QRCode from "qrcode";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaimPayload } from "../lib/claim-payload.js";
import { getDesktopIdentity, readPersistedIdentity } from "../lib/cloud-connect.js";

export const connectRouter = new Hono();

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

async function loadClaimContext() {
  const persisted = await readPersistedIdentity();
  if (!persisted) return null;

  const { desktopClientId, cloudDesktopToken } = getDesktopIdentity();
  const serverId = persisted.desktopClientId ?? desktopClientId;
  if (!serverId) return null;

  const payload = buildClaimPayload({
    serverId,
    claimSecret: persisted.claimSecret,
    cloudUrl: process.env.ALFRD_CLOUD_URL ?? "https://api.alfrd.net",
    name: persisted.displayName ?? process.env.DESKTOP_CLIENT_NAME ?? "Alfred",
  });

  return {
    persisted,
    cloudDesktopToken,
    payload,
    relayConnected: !!(cloudDesktopToken || persisted.cloudDesktopToken),
  };
}

/**
 * GET /connect/info
 * Returns the desktop client's alfrd.net identity info.
 * Used to show the claim code, and by the control plane during claim.
 */
connectRouter.get("/info", async (c) => {
  const ctx = await loadClaimContext();
  if (!ctx) {
    return c.json({ error: "not_ready" }, 503);
  }

  const { payload, relayConnected } = ctx;

  return c.json({
    // Local / product naming
    desktopClientId: payload.desktopClientId,
    claimSecret: payload.claimSecret,
    desktopClientName: payload.name,
    relayConnected,
    cloudUrl: payload.cloudUrl,
    // Control-plane / alfred-home compatibility aliases (mobile claim UI may expect these)
    serverId: payload.serverId,
    serverName: payload.name,
    // QR claim helpers
    claimUri: payload.uri,
    claimQrPath: "/connect/claim.png",
    claimPagePath: "/connect/claim",
  });
});

/**
 * GET /connect/claim.json
 * Structured claim payload for mobile / tooling (same fields encoded in the QR URI).
 */
connectRouter.get("/claim.json", async (c) => {
  const ctx = await loadClaimContext();
  if (!ctx) {
    return c.json({ error: "not_ready" }, 503);
  }
  return c.json(ctx.payload);
});

/**
 * GET /connect/claim.png
 * QR image encoding alfred://claim?... (scan with iOS camera / in-app scanner).
 */
connectRouter.get("/claim.png", async (c) => {
  const ctx = await loadClaimContext();
  if (!ctx) {
    return c.json({ error: "not_ready" }, 503);
  }

  const png = await QRCode.toBuffer(ctx.payload.uri, {
    type: "png",
    width: 512,
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#0b0f14", light: "#ffffff" },
  });

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
});

/**
 * GET /connect/claim.svg
 * Vector QR for crisp display on retina screens.
 */
connectRouter.get("/claim.svg", async (c) => {
  const ctx = await loadClaimContext();
  if (!ctx) {
    return c.json({ error: "not_ready" }, 503);
  }

  const svg = await QRCode.toString(ctx.payload.uri, {
    type: "svg",
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#0b0f14", light: "#ffffff" },
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

/**
 * GET /connect/claim
 * Local UI: QR + Desktop Client ID + 8-char claim secret (manual fallback).
 */
connectRouter.get("/claim", async (c) => {
  const ctx = await loadClaimContext();
  if (!ctx) {
    return c.json({ error: "not_ready" }, 503);
  }

  const template = await readFile(resolve(uiDir, "claim.html"), "utf8");
  const { payload, relayConnected } = ctx;
  const html = template
    .replaceAll("{{NAME}}", escapeHtml(payload.name))
    .replaceAll("{{SERVER_ID}}", escapeHtml(payload.serverId))
    .replaceAll("{{CLAIM_SECRET}}", escapeHtml(payload.claimSecret))
    .replaceAll("{{CLOUD_URL}}", escapeHtml(payload.cloudUrl))
    .replaceAll("{{CLAIM_URI}}", escapeHtml(payload.uri))
    .replaceAll("{{RELAY_STATUS}}", relayConnected ? "Relay connected" : "Relay not connected yet")
    .replaceAll("{{RELAY_CLASS}}", relayConnected ? "ok" : "warn");

  return c.html(html);
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
