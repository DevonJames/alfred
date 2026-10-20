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
import { agendaBriefingEvents } from "../lib/agenda-briefing.js";
import { oipForProfile } from "../lib/oip-memory.js";
import { loadTaskReminders } from "../lib/message-commitments.js";
import { requireDevice } from "../middleware/require-device.js";

export const briefingRouter = new Hono();

briefingRouter.use("*", requireDevice);

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

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

/** GET /api/briefing?refresh=1&launches=1 — launches are opt-in only. */
briefingRouter.get("/briefing", async (c) => {
  const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
  const includeLaunches =
    c.req.query("launches") === "1" || c.req.query("launches") === "true";
  const memory = oipForProfile();
  const controller = createBriefingController({
    memory,
    taskReminders: loadTaskReminders,
    agendaEvents: agendaBriefingEvents,
  });
  try {
    const payload = await controller.generate({
      refresh,
      markSurfaced: false,
      includeLaunches,
    });
    return c.json(payload);
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

/** GET /api/briefing/prefs — Daily Brief preferences + catalog for phone Settings. */
briefingRouter.get("/briefing/prefs", async (c) => {
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

/** PUT /api/briefing/prefs */
briefingRouter.put("/briefing/prefs", async (c) => {
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
