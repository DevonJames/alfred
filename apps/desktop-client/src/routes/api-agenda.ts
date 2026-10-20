/**
 * Device-auth Agenda API for iOS (and other remotes).
 * Wraps the same EventKit board + CRUD as the local /agenda HTML UI.
 */
import { agendaWindow } from "@alfred/calendar-gateway";
import { Hono } from "hono";
import {
  blockRunsOn,
  cleanAgendaBlock,
  loadAgendaBlocks,
  saveAgendaBlocks,
  type AgendaTimeBlock,
} from "../lib/agenda-blocks.js";
import {
  agendaHttpError,
  createAgendaEvent,
  deleteAgendaEvent,
  listAgendaCalendars,
  updateAgendaEvent,
} from "../lib/agenda-events.js";
import { listOpenRemindersForPlace, placeReminderInBlock } from "../lib/agenda-place.js";
import {
  agendaBoard,
  agendaFocusInstant,
  agendaTimeZone,
  agendaViewFrom,
} from "../lib/agenda-turn.js";
import { loadStandardPlan } from "../lib/standard-plan.js";
import { requireSidecarOrDevice } from "../middleware/sidecar-or-device.js";

export const apiAgendaRouter = new Hono();

apiAgendaRouter.use("*", requireSidecarOrDevice);

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

/** GET /api/agenda/board?view=today|week&date=YYYY-MM-DD */
apiAgendaRouter.get("/board", async (c) => {
  const view = agendaViewFrom(c.req.query("view"));
  const zone = agendaTimeZone();
  const focus = agendaFocusInstant(c.req.query("date"), zone);
  try {
    return c.json(await agendaBoard(view, focus));
  } catch (err) {
    const window = agendaWindow(view, new Date(), zone, focus);
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ...window, calendars: [], error: message });
  }
});

/** GET /api/agenda/calendars — readable/writable calendars for create UI. */
apiAgendaRouter.get("/calendars", async (c) => {
  try {
    const calendars = await listAgendaCalendars();
    return c.json({ calendars });
  } catch (err) {
    const { message, status } = agendaHttpError(err);
    return c.json({ error: message, calendars: [] }, status);
  }
});

/** POST /api/agenda/event — create */
apiAgendaRouter.post("/event", async (c) => {
  let body: {
    calendarId?: unknown;
    title?: unknown;
    start?: unknown;
    end?: unknown;
    date?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const calendarId = typeof body.calendarId === "string" ? body.calendarId.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const start = typeof body.start === "string" ? body.start.trim() : "";
  const end = typeof body.end === "string" ? body.end.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (
    !calendarId ||
    !title ||
    !/^\d{2}:\d{2}$/.test(start) ||
    !/^\d{2}:\d{2}$/.test(end) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return c.json({ error: "An event needs a calendar, a title, a start, and an end." }, 400);
  }
  try {
    const event = await createAgendaEvent({ calendarId, title, start, end, date });
    return c.json({ ok: true, event });
  } catch (err) {
    const { message, status } = agendaHttpError(err);
    return c.json({ error: message }, status);
  }
});

/** PATCH /api/agenda/event/:id — update */
apiAgendaRouter.patch("/event/:id", async (c) => {
  const id = c.req.param("id")?.trim() ?? "";
  let body: {
    title?: unknown;
    start?: unknown;
    end?: unknown;
    anchor?: unknown;
    calendarId?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const start = typeof body.start === "string" ? body.start.trim() : "";
  const end = typeof body.end === "string" ? body.end.trim() : "";
  const anchor = typeof body.anchor === "string" ? body.anchor.trim() : "";
  const calendarId = typeof body.calendarId === "string" ? body.calendarId.trim() : undefined;
  if (!id || !title || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || !anchor) {
    return c.json({ error: "An event needs a title, a start, and an end." }, 400);
  }
  try {
    const event = await updateAgendaEvent({
      id,
      title,
      start,
      end,
      anchor,
      calendarId,
    });
    return c.json({ ok: true, event });
  } catch (err) {
    const { message, status } = agendaHttpError(err);
    return c.json({ error: message }, status);
  }
});

/** DELETE /api/agenda/event/:id */
apiAgendaRouter.delete("/event/:id", async (c) => {
  const id = c.req.param("id")?.trim() ?? "";
  if (!id) return c.json({ error: "id is required" }, 400);
  try {
    await deleteAgendaEvent(id);
    return c.json({ ok: true });
  } catch (err) {
    const { message, status } = agendaHttpError(err);
    return c.json({ error: message }, status);
  }
});

/** GET /api/agenda/blocks?date=YYYY-MM-DD — named time blocks (+ activeOnDate). */
apiAgendaRouter.get("/blocks", async (c) => {
  const file = await loadAgendaBlocks(profileId());
  const date = c.req.query("date")?.trim() ?? "";
  const focus =
    /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : new Intl.DateTimeFormat("en-CA", {
          timeZone: agendaTimeZone(),
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
  const blocks = file.blocks.map((block) => ({
    ...block,
    activeOnDate: blockRunsOn(block, focus),
  }));
  return c.json({ date: focus, blocks });
});

/** PUT /api/agenda/blocks — replace the saved time-block list. */
apiAgendaRouter.put("/blocks", async (c) => {
  let body: { blocks?: unknown };
  try {
    body = (await c.req.json()) as { blocks?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.blocks)) return c.json({ error: "Expected blocks" }, 400);
  const blocks: AgendaTimeBlock[] = [];
  for (const raw of body.blocks) {
    const block = cleanAgendaBlock(raw);
    if (!block) return c.json({ error: "Each block needs a name, a time range, and a calendar." }, 400);
    blocks.push(block);
  }
  const known = new Set((await loadStandardPlan(profileId())).categories.map((category) => category.id));
  const hosted = blocks.map((block) => ({
    ...block,
    categoryIds: block.categoryIds.filter((id) => known.has(id)),
  }));
  const existing = await loadAgendaBlocks(profileId());
  await saveAgendaBlocks({ blocks: hosted, placed: existing.placed }, profileId());
  return c.json({ ok: true, blocks: hosted });
});

/** GET /api/agenda/open-reminders — Apple Reminders open items for Place into block. */
apiAgendaRouter.get("/open-reminders", async (c) => {
  try {
    const reminders = await listOpenRemindersForPlace();
    return c.json({ reminders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ reminders: [], error: message });
  }
});

/** POST /api/agenda/place — drop a reminder into a time block. */
apiAgendaRouter.post("/place", async (c) => {
  let body: {
    reminderId?: unknown;
    blockId?: unknown;
    durationMinutes?: unknown;
    date?: unknown;
    choice?: unknown;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const result = await placeReminderInBlock({
    reminderId: typeof body.reminderId === "string" ? body.reminderId.trim() : "",
    blockId: typeof body.blockId === "string" ? body.blockId.trim() : "",
    durationMinutes:
      typeof body.durationMinutes === "number" ? Math.round(body.durationMinutes) : Number.NaN,
    date: typeof body.date === "string" ? body.date : null,
    choice: body.choice === "overlap" || body.choice === "next" ? body.choice : null,
  });
  if (!result.ok) {
    return c.json(result.body, result.status as 200 | 400 | 403 | 404 | 500);
  }
  return c.json({
    ok: true,
    event: result.event,
    date: result.date,
    start: result.start,
    end: result.end,
    label: result.label,
  });
});
