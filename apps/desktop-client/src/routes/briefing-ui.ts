import {
  CRYPTO_OPTIONS,
  LAUNCH_SITE_OPTIONS,
  NEWS_SOURCE_OPTIONS,
  createBriefingController,
  createBriefingModuleFromAsk,
  listBriefingModules,
  loadBriefingPrefs,
  saveBriefingPrefs,
  setBriefingModuleEnabled,
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
import { getBriefingHud, greetingLlm, resetSpeechEngineBriefingOffer } from "../lib/speech-engine.js";

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
  const modules = await listBriefingModules(profileId());
  let calendars: Array<{ id: string; label: string }> = [];
  try {
    calendars = await agendaCalendars();
  } catch (err) {
    console.warn("[briefing] agenda calendars", err instanceof Error ? err.message : err);
  }
  return c.json({
    prefs,
    modules,
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

/** POST /briefing/modules — design a section from a written request and save it. */
briefingUiRouter.post("/modules", async (c) => {
  let body: { request?: unknown };
  try {
    body = (await c.req.json()) as { request?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (!request) return c.json({ error: "Describe the section to add." }, 400);
  try {
    const created = await createBriefingModuleFromAsk({
      request,
      llm: greetingLlm,
      profileId: profileId(),
    });
    await createBriefingController({}).invalidateTodayCache().catch(() => {});
    return c.json({ module: created.module, speech: created.speech });
  } catch (err) {
    console.error("[briefing] add module failed:", err);
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

/** PATCH /briefing/modules/:id — enable or disable a user-added section. */
briefingUiRouter.patch("/modules/:id", async (c) => {
  let body: { enabled?: unknown };
  try {
    body = (await c.req.json()) as { enabled?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  try {
    const module = await setBriefingModuleEnabled(c.req.param("id"), body.enabled, profileId());
    await createBriefingController({}).invalidateTodayCache().catch(() => {});
    return c.json({ module });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
  }
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
