import { Hono } from "hono";
import {
  applyPrivacyTighten,
  loadDesktopSettings,
  saveDesktopSettings,
  type PrivacyMode,
  type VoiceMode,
} from "../lib/desktop-settings.js";
import { extractBearerToken } from "../lib/device-auth.js";
import { findDeviceByToken } from "../lib/device-store.js";
import { activeProfileId } from "../lib/oip-memory.js";
import { requireSidecarOrDevice } from "../middleware/sidecar-or-device.js";

export const settingsRouter = new Hono();

settingsRouter.use("*", requireSidecarOrDevice);

function desktopName(): string {
  return process.env.DESKTOP_CLIENT_NAME?.trim() || "Alfred";
}

async function settingsPayload(authHeader: string | undefined) {
  const file = await loadDesktopSettings();
  const token = extractBearerToken(authHeader);
  const device = token ? await findDeviceByToken(token) : null;
  return {
    settings: {
      privacyMode: file.privacyMode,
      activeMemoryProvider: process.env.ALFRED_MEMORY_PROVIDER_ID?.trim() || "memory.oip-local",
      voiceMode: file.voiceMode,
      profileId: activeProfileId(),
      desktopName: desktopName(),
      device: device
        ? { id: device.id, name: device.name, scopes: ["memory", "voice", "settings"] }
        : { id: "local", name: "local", scopes: ["memory", "voice", "settings"] },
      providerSelectorsLocked: true,
    },
  };
}

/** GET /api/settings */
settingsRouter.get("/", async (c) => {
  return c.json(await settingsPayload(c.req.header("Authorization")));
});

/** PATCH /api/settings — phone may only tighten privacyMode. */
settingsRouter.patch("/", async (c) => {
  let body: { privacyMode?: string; voiceMode?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const current = await loadDesktopSettings();
  let privacyMode = current.privacyMode;
  let voiceMode = current.voiceMode;

  if (body.privacyMode) {
    const requested = body.privacyMode as PrivacyMode;
    if (
      requested !== "local_only" &&
      requested !== "private_hybrid" &&
      requested !== "user_managed"
    ) {
      return c.json({ error: "Invalid privacyMode" }, 400);
    }
    const tightened = applyPrivacyTighten(current.privacyMode, requested);
    if (!tightened) {
      return c.json(
        {
          error: "Privacy can only be tightened from the phone. Loosen it on the Mac.",
          code: "privacy_loosen_forbidden",
        },
        403,
      );
    }
    privacyMode = tightened;
  }

  if (body.voiceMode) {
    const requested = body.voiceMode as VoiceMode;
    if (requested !== "cascaded" && requested !== "unified") {
      return c.json({ error: "Invalid voiceMode" }, 400);
    }
    voiceMode = requested;
  }

  await saveDesktopSettings({
    privacyMode,
    voiceMode,
    browserChannel: current.browserChannel,
  });
  return c.json(await settingsPayload(c.req.header("Authorization")));
});
