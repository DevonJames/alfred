import {
  CRYPTO_OPTIONS,
  LAUNCH_SITE_OPTIONS,
  NEWS_SOURCE_OPTIONS,
  createBriefingController,
  loadBriefingPrefs,
  saveBriefingPrefs,
  type BriefingPrefs,
} from "@alfred/briefing";
import {
  calendarPolicyPath,
  createEventKitGateway,
  loadCalendarPolicy,
  mergeCalendarAccess,
  readableCalendars,
} from "@alfred/calendar-gateway";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBriefingHud, resetSpeechEngineBriefingOffer } from "../lib/speech-engine.js";

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

/** GET /briefing/hud — last structured Daily Brief layout for the voice UI. */
briefingUiRouter.get("/hud", (c) => {
  const hud = getBriefingHud();
  return c.json({
    active: Boolean(hud),
    display: hud?.display ?? null,
    spokenAt: hud?.spokenAt ?? null,
  });
});

async function agendaCalendars(): Promise<Array<{ id: string; label: string }>> {
  const file = calendarPolicyPath(profileId());
  const gateway = createEventKitGateway(file);
  const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
  return readableCalendars(mergeCalendarAccess(discovered, policy).sources)
    .map((calendar) => ({
      id: calendar.id,
      label: `${calendar.title} · ${calendar.sourceTitle}`,
      source: calendar.sourceTitle,
      title: calendar.title,
    }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title))
    .map(({ id, label }) => ({ id, label }));
}

/** GET /briefing/prefs */
briefingUiRouter.get("/prefs", async (c) => {
  const prefs = await loadBriefingPrefs(profileId());
  let calendars: Array<{ id: string; label: string }> = [];
  try {
    calendars = await agendaCalendars();
  } catch (err) {
    console.warn("[briefing] agenda calendars", err instanceof Error ? err.message : err);
  }
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
      calendars,
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
  await createBriefingController({}).invalidateTodayCache().catch(() => {});
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
