import {
  CRYPTO_OPTIONS,
  LAUNCH_SITE_OPTIONS,
  NEWS_SOURCE_OPTIONS,
  loadBriefingPrefs,
  saveBriefingPrefs,
  type BriefingPrefs,
} from "@alfred/briefing";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetSpeechEngineBriefingOffer } from "../lib/speech-engine.js";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

export const briefingUiRouter = new Hono();

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

/** GET /briefing — preferences UI */
briefingUiRouter.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "briefing.html"), "utf8");
  return c.html(html);
});

/** GET /briefing/prefs */
briefingUiRouter.get("/prefs", async (c) => {
  const prefs = await loadBriefingPrefs(profileId());
  return c.json({
    prefs,
    catalog: {
      launchSites: LAUNCH_SITE_OPTIONS,
      crypto: CRYPTO_OPTIONS,
      metals: [
        { id: "gold", label: "Gold" },
        { id: "silver", label: "Silver" },
      ],
      newsSources: NEWS_SOURCE_OPTIONS,
      launchesModes: [
        { id: "on", label: "On" },
        { id: "off", label: "Off" },
        { id: "request", label: "By request" },
      ],
    },
  });
});

/** PUT /briefing/prefs */
briefingUiRouter.put("/prefs", async (c) => {
  let body: Partial<BriefingPrefs>;
  try {
    body = (await c.req.json()) as Partial<BriefingPrefs>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const current = await loadBriefingPrefs(profileId());
  const next = await saveBriefingPrefs({ ...current, ...body }, profileId());
  return c.json({ prefs: next, saved: true });
});

/** POST /briefing/reset-offer — clear today's offer/play state so soft-offer can fire again. */
briefingUiRouter.post("/reset-offer", async (c) => {
  try {
    await resetSpeechEngineBriefingOffer();
    return c.json({ reset: true });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
