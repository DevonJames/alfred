import {
  agendaWindow,
  calendarPolicyPath,
  CalendarHelperError,
  createEventKitGateway,
  loadCalendarPolicy,
  mergeCalendarAccess,
  readableCalendars,
  zonedDateTime,
  type CalendarEvent,
} from "@alfred/calendar-gateway";
import { dateKeyInZone, dueDateKey } from "@alfred/reminders-gateway";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agendaBoard,
  agendaFocusInstant,
  agendaTimeZone,
  agendaViewFrom,
  answerAgendaTurn,
  setAgendaEar,
} from "../lib/agenda-turn.js";
import {
  blockRunsOn,
  cleanAgendaBlock,
  loadAgendaBlocks,
  parseClock,
  saveAgendaBlocks,
  shiftDate,
  type AgendaTimeBlock,
} from "../lib/agenda-blocks.js";
import { placeReminderInBlock } from "../lib/agenda-place.js";
import { listOpenReminders } from "../lib/message-commitments.js";
import { draftPlan } from "../lib/agenda-llm.js";
import {
  applyChatItems,
  assignDefaultPlanDate,
  cleanClientLine,
  defaultPlanDate,
  formatPlanGaps,
  messageNamesDate,
  nextHourStart,
  ensureRequestedPlanItem,
  openPlanGaps,
  clockOnPlanDate,
  lineFitsBlock,
  linesToCommit,
  loadStoredPlan,
  mergePlan,
  parsePlanReply,
  planPeriod,
  planScope,
  saveStoredPlan,
  sortPlanLines,
  type PlanChatTurn,
  type PlanLine,
} from "../lib/agenda-plan.js";
import { isSpeechEngineStack, primeVerbatimSpeech } from "../lib/speech-engine.js";
import {
  busyFromLines,
  coveredMinutes,
  draftFromSlice,
  fillBlockHours,
  hoursToMinutes,
  loadStandardPlan,
  monthAnchorLabel,
  parseStandardPlan,
  placeSession,
  planIsSaved,
  splitMinutes,
  resolveMonthDate,
  saveStandardPlan,
  totalClaimedHours,
  type PlanCategory,
} from "../lib/standard-plan.js";

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");

export const agendaUiRouter = new Hono();

function profileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}

/** GET /agenda — agenda board. */
agendaUiRouter.get("/", async (c) => {
  const html = await readFile(resolve(uiDir, "agenda.html"), "utf8");
  return c.html(html);
});

/** GET /agenda/board?view=today|week&date=YYYY-MM-DD */
agendaUiRouter.get("/board", async (c) => {
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

/** POST /agenda/event/delete — remove one event from a calendar open for writes. */
agendaUiRouter.post("/event/delete", async (c) => {
  let body: { id?: unknown };
  try {
    body = (await c.req.json()) as { id?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return c.json({ error: "id is required" }, 400);
  try {
    const gateway = createEventKitGateway(calendarPolicyPath(profileId()));
    await gateway.delete(id);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof CalendarHelperError && err.code === "calendar_denied" ? 403 : 500;
    return c.json({ error: message }, status);
  }
});

/** POST /agenda/event/create — add one event on a calendar open for writes. */
agendaUiRouter.post("/event/create", async (c) => {
  let body: { calendarId?: unknown; title?: unknown; start?: unknown; end?: unknown; date?: unknown };
  try {
    body = (await c.req.json()) as {
      calendarId?: unknown;
      title?: unknown;
      start?: unknown;
      end?: unknown;
      date?: unknown;
    };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const calendarId = typeof body.calendarId === "string" ? body.calendarId.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const startClock = typeof body.start === "string" ? body.start.trim() : "";
  const endClock = typeof body.end === "string" ? body.end.trim() : "";
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (
    !calendarId ||
    !title ||
    !/^\d{2}:\d{2}$/.test(startClock) ||
    !/^\d{2}:\d{2}$/.test(endClock) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return c.json({ error: "An event needs a calendar, a title, a start, and an end." }, 400);
  }
  const zone = agendaTimeZone();
  const start = clockOnDate(date, startClock, zone);
  let end = clockOnDate(date, endClock, zone);
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);
  try {
    const file = calendarPolicyPath(profileId());
    const gateway = createEventKitGateway(file);
    const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
    const destination = readableCalendars(mergeCalendarAccess(discovered, policy).sources).find(
      (calendar) => calendar.id === calendarId,
    );
    if (!destination || destination.access !== "write") {
      return c.json({ error: "That calendar is not open for writes." }, 403);
    }
    const event = await gateway.create({
      calendarId,
      title,
      start: start.toISOString(),
      end: end.toISOString(),
    });
    return c.json({ ok: true, event });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof CalendarHelperError && err.code === "calendar_denied" ? 403 : 500;
    return c.json({ error: message }, status);
  }
});

/** POST /agenda/event/update — change the title, clock time, or writable calendar of one event. */
agendaUiRouter.post("/event/update", async (c) => {
  let body: { id?: unknown; title?: unknown; start?: unknown; end?: unknown; anchor?: unknown; calendarId?: unknown };
  try {
    body = (await c.req.json()) as {
      id?: unknown;
      title?: unknown;
      start?: unknown;
      end?: unknown;
      anchor?: unknown;
      calendarId?: unknown;
    };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const startClock = typeof body.start === "string" ? body.start.trim() : "";
  const endClock = typeof body.end === "string" ? body.end.trim() : "";
  const anchor = typeof body.anchor === "string" ? body.anchor.trim() : "";
  const calendarId = typeof body.calendarId === "string" ? body.calendarId.trim() : "";
  if (!id || !title || !/^\d{2}:\d{2}$/.test(startClock) || !/^\d{2}:\d{2}$/.test(endClock) || !anchor) {
    return c.json({ error: "An event needs a title, a start, and an end." }, 400);
  }
  const zone = agendaTimeZone();
  const start = clockOnDay(anchor, startClock, zone);
  let end = clockOnDay(anchor, endClock, zone);
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);
  try {
    const file = calendarPolicyPath(profileId());
    const gateway = createEventKitGateway(file);
    if (calendarId) {
      const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
      const destination = readableCalendars(mergeCalendarAccess(discovered, policy).sources).find(
        (calendar) => calendar.id === calendarId,
      );
      if (!destination || destination.access !== "write") {
        return c.json({ error: "That calendar is not open for writes." }, 403);
      }
    }
    const event = await gateway.update({
      eventId: id,
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      ...(calendarId ? { calendarId } : {}),
    });
    return c.json({ ok: true, event });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof CalendarHelperError && err.code === "calendar_denied" ? 403 : 500;
    return c.json({ error: message }, status);
  }
});

/** GET /agenda/settings — name the day's time blocks. */
agendaUiRouter.get("/settings", async (c) => {
  const html = await readFile(resolve(uiDir, "agenda-settings.html"), "utf8");
  return c.html(html);
});

agendaUiRouter.get("/blocks", async (c) => {
  const file = await loadAgendaBlocks(profileId());
  return c.json({ blocks: file.blocks });
});

agendaUiRouter.put("/blocks", async (c) => {
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

/** GET /agenda/standard-plan — setup wizard, then the editor. */
agendaUiRouter.get("/standard-plan", async (c) => {
  const html = await readFile(resolve(uiDir, "standard-plan.html"), "utf8");
  return c.html(html);
});

/** GET /agenda/standard-plan/data — the saved week, plus where each category lands in `date`'s week. */
agendaUiRouter.get("/standard-plan/data", async (c) => {
  const plan = await loadStandardPlan(profileId());
  const date = c.req.query("date") ?? "";
  return c.json({
    weeklyHours: plan.weeklyHours,
    categories: plan.categories,
    claimedHours: totalClaimedHours(plan.categories),
    saved: planIsSaved(plan),
    ...(await weekAnnotations(plan.categories, date)),
  });
});

agendaUiRouter.put("/standard-plan", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = parseStandardPlan(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  await saveStandardPlan(parsed.plan, profileId());
  return c.json({
    ok: true,
    weeklyHours: parsed.plan.weeklyHours,
    categories: parsed.plan.categories,
    claimedHours: totalClaimedHours(parsed.plan.categories),
    saved: true,
  });
});

/** POST /agenda/standard-plan/fill — draft weekly categories, or one every-two-weeks category, into this week. */
agendaUiRouter.post("/standard-plan/fill", async (c) => {
  let body: { date?: unknown; items?: unknown; categoryId?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const only = typeof body.categoryId === "string" ? body.categoryId.trim() : "";
  try {
    const view = await loadPlanView("week", typeof body.date === "string" ? body.date : "");
    const plan = await loadStandardPlan(profileId());
    if (only) {
      const chosen = plan.categories.find((category) => category.id === only);
      if (!chosen || (chosen.cadence !== "fortnight" && chosen.cadence !== "week")) {
        return c.json({ error: "That category is not planned across a week." }, 400);
      }
    }
    const items = postedPlanLines(body.items, view.period.dates) ?? view.items;
    const skip = new Set(view.skipOverlapIds);
    const unplaced: { name: string; minutes: number; reason: "unassigned" | "full" }[] = [];
    const drafts = [];
    for (const category of plan.categories) {
      if (only ? category.id !== only : category.cadence !== "week") continue;
      const hosts = blocksHosting(view.blocks, category.id);
      if (!hosts.length) {
        unplaced.push({ name: category.name, minutes: hoursToMinutes(category.hours), reason: "unassigned" });
        continue;
      }
      const placed = spreadCategory({
        category,
        hosts,
        dates: view.period.dates,
        items,
        skip,
      });
      drafts.push(...placed.drafts);
      if (placed.unplaced > 0) unplaced.push({ name: category.name, minutes: placed.unplaced, reason: "full" });
    }
    return c.json({ ok: true, drafts, unplaced });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

/** POST /agenda/standard-plan/place — draft one daily or monthly session into its block. */
agendaUiRouter.post("/standard-plan/place", async (c) => {
  let body: { categoryId?: unknown; date?: unknown; items?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const categoryId = typeof body.categoryId === "string" ? body.categoryId.trim() : "";
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : "";
  if (!categoryId || !date) return c.json({ error: "Choose a category and a day." }, 400);
  try {
    const view = await loadPlanView("week", date);
    const plan = await loadStandardPlan(profileId());
    const category = plan.categories.find((item) => item.id === categoryId);
    if (!category || category.cadence === "week" || category.cadence === "fortnight") {
      return c.json({ error: "That category is planned with the week." }, 400);
    }
    const hosts = blocksHosting(view.blocks, category.id);
    if (!hosts.length) return c.json({ error: `${category.name} is not on a time block yet.` }, 400);
    const items = postedPlanLines(body.items, view.period.dates) ?? view.items;
    const skip = new Set(view.skipOverlapIds);
    const running = hosts.filter((block) => blockRunsOn(block, date));
    if (!running.length) {
      const nextDate = view.period.dates.find((iso) => iso > date && hosts.some((block) => blockRunsOn(block, iso)));
      return c.json({
        ok: false,
        choice: "off-day",
        message: `${hostLabel(hosts)} does not run on ${dayLabel(date)}.`,
        next: nextDate ? { date: nextDate, label: dayLabel(nextDate) } : null,
      });
    }
    const shares = splitMinutes(hoursToMinutes(category.hours), running.length);
    const drafts = [];
    let carry = 0;
    let failure: { status: string; message: string; next: { date: string; label: string } | null } | null = null;
    for (let index = 0; index < running.length; index += 1) {
      const block = running[index]!;
      const ask = (shares[index] ?? 0) + carry;
      carry = 0;
      if (ask <= 0) continue;
      const placed = placeSession({
        date,
        block,
        minutes: ask,
        dates: view.period.dates,
        busyOn: (iso) => busyFromLines(items, iso, skip),
      });
      if (placed.status === "fit" && placed.startMin != null && placed.endMin != null) {
        const draft = draftFromSlice({
          categoryName: category.name,
          calendarId: block.calendarId,
          date,
          startMin: placed.startMin,
          endMin: placed.endMin,
        });
        drafts.push(draft);
        items.push(draft);
        continue;
      }
      const last = index === running.length - 1;
      if (!last) {
        carry = ask;
        continue;
      }
      const next = placed.next ? { date: placed.next.date, label: dayLabel(placed.next.date) } : null;
      failure = {
        status: placed.status,
        message:
          placed.status === "overlap"
            ? `This overlaps ${placed.overlapTitle ?? "another event"}.`
            : placed.status === "too-short"
              ? `${block.name} is shorter than this duration.`
              : "That day is not in this week.",
        next,
      };
    }
    if (drafts.length) return c.json({ ok: true, drafts, draft: drafts[0] });
    if (failure) return c.json({ ok: false, choice: failure.status, message: failure.message, next: failure.next });
    return c.json({ error: `${category.name} did not fit.` }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

agendaUiRouter.get("/calendars", async (c) => {
  try {
    const calendars = await writableCalendars();
    return c.json({
      calendars: calendars.map((calendar) => ({
        id: calendar.id,
        title: calendar.title,
        sourceTitle: calendar.sourceTitle,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ calendars: [], error: message }, 200);
  }
});

agendaUiRouter.get("/plan", async (c) => {
  try {
    const loaded = await loadPlanView(planScope(c.req.query("scope")), c.req.query("date") ?? "");
    return c.json(loaded);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

agendaUiRouter.post("/plan", async (c) => {
  let body: { scope?: unknown; date?: unknown; items?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  try {
    const view = await loadPlanView(planScope(body.scope), typeof body.date === "string" ? body.date : "");
    const items = Array.isArray(body.items)
      ? body.items.flatMap((item) => {
          const line = cleanClientLine(item);
          return line && view.period.dates.includes(line.date) ? [line] : [];
        })
      : [];
    await saveStoredPlan(
      { scope: view.period.scope, anchor: view.period.anchor, items, chat: view.chat },
      view.period.start,
      profileId(),
    );
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

agendaUiRouter.post("/plan/chat", async (c) => {
  let body: { scope?: unknown; date?: unknown; text?: unknown; items?: unknown; selected?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "Say what you want in this plan." }, 400);
  try {
    const view = await loadPlanView(planScope(body.scope), typeof body.date === "string" ? body.date : "");
    const edited = Array.isArray(body.items) ? body.items.flatMap((item) => {
      const line = cleanClientLine(item);
      return line && view.period.dates.includes(line.date) ? [line] : [];
    }) : view.items;
    const calendars = view.calendars;
    const writableIds = new Set(calendars.map((calendar) => calendar.id));
    const skipOverlapIds = new Set(view.skipOverlapIds);
    const zone = agendaTimeZone();
    const today = dateKeyInZone(new Date(), zone);
    const selected =
      view.period.scope === "day"
        ? view.period.dates[0] ?? null
        : typeof body.selected === "string" && view.period.dates.includes(body.selected)
          ? body.selected
          : null;
    const fallbackDay = defaultPlanDate({ message: text, dates: view.period.dates, today, selected });
    const nowMin = minutesInZone(new Date().toISOString(), zone);
    const fromMin = fallbackDay === today ? nextHourStart(nowMin) : 0;
    const clockLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date());
    const blocks = view.blocks
      .flatMap((block) =>
        view.period.dates
          .filter((date) => blockRunsOn(block, date))
          .map((date) => `${date} ${block.name} ${block.start}–${block.end} calendar ${block.calendarId}`),
      )
      .join("\n");
    const history: PlanChatTurn[] = view.chat.slice(-11);
    history.push({ role: "user", text });
    const raw = await draftPlan({
      message: text,
      periodLabel: view.period.label,
      dates: view.period.dates,
      blocks,
      calendars: calendars.map((calendar) => `${calendar.id} ${calendar.title}`).join("\n"),
      items: planItemsForModel(edited, skipOverlapIds),
      defaultDate: fallbackDay ?? undefined,
      open: fallbackDay ? formatPlanGaps(openPlanGaps(edited, fallbackDay, skipOverlapIds, fromMin)) : undefined,
      clock: fallbackDay === today ? `${clockLabel}. New items start at the next open hour.` : undefined,
      history: history
        .slice(0, -1)
        .map((turn) => `${turn.role}: ${turn.text}`)
        .join("\n"),
    });
    const parsed = raw ? parsePlanReply(raw) : null;
    if (!parsed) {
      return c.json({ error: "I couldn't turn that into separate items.", items: edited, chat: view.chat });
    }
    const ensured = ensureRequestedPlanItem({
      current: edited,
      incoming: assignDefaultPlanDate(edited, parsed.items, messageNamesDate(text) ? null : fallbackDay),
      today,
      day: fallbackDay,
      nowMin,
      message: text,
      reply: parsed.reply,
      skipOverlapIds,
    });
    const incoming = ensured.items.flatMap((item) => {
      if (!view.period.dates.includes(item.date)) return [];
      const existing = edited.some((line) => line.eventId && line.eventId === item.eventId);
      let calendarId = resolvePlanCalendar(item.calendarId ?? "", calendars, view.blocks, item.date, item.start);
      if (calendarId && !writableIds.has(calendarId) && !existing) {
        calendarId = resolvePlanCalendar("", calendars, view.blocks, item.date, item.start);
      }
      if (!calendarId && !existing) calendarId = calendars[0]?.id ?? "";
      return [{ ...item, calendarId }];
    });
    const items = applyChatItems(edited, incoming, () => randomUUID());
    const reply = ensured.reply || "Updated the plan.";
    const chat: PlanChatTurn[] = history.slice(-15);
    chat.push({ role: "assistant", text: reply });
    await saveStoredPlan({ scope: view.period.scope, anchor: view.period.anchor, items, chat }, view.period.start, profileId());
    return c.json({ reply, items, chat, period: view.period, blocks: view.blocks, calendars });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

agendaUiRouter.post("/plan/commit", async (c) => {
  let body: { scope?: unknown; date?: unknown; items?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  try {
    const view = await loadPlanView(planScope(body.scope), typeof body.date === "string" ? body.date : "");
    const lines = Array.isArray(body.items)
      ? body.items.flatMap((item) => {
          const line = cleanClientLine(item);
          return line && view.period.dates.includes(line.date) ? [line] : [];
        })
      : [];
    const writable = new Set(view.calendars.map((calendar) => calendar.id));
    const { create, update } = linesToCommit(lines);
    const file = calendarPolicyPath(profileId());
    const gateway = createEventKitGateway(file);
    const zone = agendaTimeZone();
    const errors: string[] = [];
    let created = 0;
    let updated = 0;
    const written = new Map<string, string>();
    for (const line of create) {
      if (!writable.has(line.calendarId)) {
        errors.push(`${line.title} needs a calendar you can write.`);
        continue;
      }
      const span = planSpan(line, zone);
      if (!span) {
        errors.push(`${line.title} needs an end after its start.`);
        continue;
      }
      const event = await gateway.create({
        calendarId: line.calendarId,
        title: line.title,
        start: span.start,
        end: span.end,
      });
      written.set(line.key, event.id);
      created += 1;
    }
    for (const line of update) {
      if (!line.eventId || !writable.has(line.calendarId)) {
        errors.push(`${line.title} stays as it is because that calendar is not open for writes.`);
        continue;
      }
      const span = planSpan(line, zone);
      if (!span) {
        errors.push(`${line.title} needs an end after its start.`);
        continue;
      }
      await gateway.update({
        eventId: line.eventId,
        title: line.title,
        start: span.start,
        end: span.end,
        calendarId: line.calendarId,
      });
      updated += 1;
    }
    const items = lines.map((line) => {
      const eventId = written.get(line.key) ?? line.eventId;
      return { ...line, eventId, origin: eventId ? ("calendar" as const) : line.origin, dirty: false };
    });
    await saveStoredPlan(
      { scope: view.period.scope, anchor: view.period.anchor, items, chat: view.chat },
      view.period.start,
      profileId(),
    );
    return c.json({
      created,
      updated,
      errors,
      items,
      period: view.period,
      blocks: view.blocks,
      calendars: view.calendars,
      chat: view.chat,
    });
  } catch (err) {
    const message = err instanceof CalendarHelperError ? err.message : err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

agendaUiRouter.get("/reminders", async (c) => {
  try {
    const zone = agendaTimeZone();
    const reminders = await listOpenReminders();
    return c.json({
      reminders: reminders
        .filter((reminder) => !reminder.completed)
        .map((reminder) => ({
          id: reminder.id,
          title: reminder.title,
          due: dueDateKey(reminder.due, zone),
          listTitle: reminder.listTitle,
        })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ reminders: [], error: message }, 200);
  }
});

/** POST /agenda/place — drop a reminder into a time block, or ask before overlapping. */
agendaUiRouter.post("/place", async (c) => {
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

function blocksHosting(blocks: AgendaTimeBlock[], categoryId: string): AgendaTimeBlock[] {
  return blocks.filter((block) => block.categoryIds.includes(categoryId));
}

function hostLabel(blocks: AgendaTimeBlock[]): string {
  if (blocks.length === 1) return blocks[0]!.name;
  return "Those blocks";
}

function spreadCategory(input: {
  category: PlanCategory;
  hosts: AgendaTimeBlock[];
  dates: string[];
  items: PlanLine[];
  skip: Set<string>;
}): { drafts: ReturnType<typeof draftFromSlice>[]; unplaced: number } {
  const drafts: ReturnType<typeof draftFromSlice>[] = [];
  let already = 0;
  for (const block of input.hosts) {
    const start = parseClock(block.start);
    const end = parseClock(block.end);
    if (start == null || end == null) continue;
    const running = input.dates.filter((date) => blockRunsOn(block, date));
    already += coveredMinutes(input.items, input.category.name, running, start, end, input.skip);
  }
  let remaining = Math.max(0, hoursToMinutes(input.category.hours) - already);
  if (remaining <= 0) return { drafts, unplaced: 0 };
  const shares = splitMinutes(remaining, input.hosts.length);
  let carry = 0;
  for (let index = 0; index < input.hosts.length; index += 1) {
    const block = input.hosts[index]!;
    const ask = (shares[index] ?? 0) + carry;
    carry = 0;
    if (ask <= 0) continue;
    const start = parseClock(block.start);
    const end = parseClock(block.end);
    if (start == null || end == null) {
      carry = ask;
      continue;
    }
    const running = input.dates.filter((date) => blockRunsOn(block, date));
    const filled = fillBlockHours({
      dates: running,
      blockStart: start,
      blockEnd: end,
      requests: [{ categoryId: input.category.id, minutes: ask }],
      busyOn: (date) => busyFromLines(input.items, date, input.skip),
    });
    for (const slice of filled.slices) {
      const draft = draftFromSlice({
        categoryName: input.category.name,
        calendarId: block.calendarId,
        date: slice.date,
        startMin: slice.startMin,
        endMin: slice.endMin,
      });
      drafts.push(draft);
      input.items.push(draft);
    }
    carry = filled.unplaced.reduce((sum, left) => sum + left.minutes, 0);
  }
  return { drafts, unplaced: carry };
}

function postedPlanLines(raw: unknown, dates: string[]): PlanLine[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((item) => {
    const line = cleanClientLine(item);
    return line && dates.includes(line.date) ? [line] : [];
  });
}

async function weekAnnotations(categories: PlanCategory[], date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return {};
  const period = planPeriod("week", date);
  const blocks = (await loadAgendaBlocks(profileId())).blocks;
  const months = [...new Set(period.dates.map((iso) => iso.slice(0, 7)))];
  return {
    week: {
      dates: period.dates,
      label: period.label,
      rows: categories.map((category) => {
        const hosts = blocksHosting(blocks, category.id);
        const month = category.cadence === "month" && category.monthAnchor ? monthInWeek(category.monthAnchor, period.dates, months) : null;
        return {
          id: category.id,
          blockId: hosts[0]?.id ?? null,
          blockName: hosts.length ? hosts.map((block) => block.name).join(" · ") : null,
          runs: period.dates.filter((iso) => hosts.some((block) => blockRunsOn(block, iso))),
          monthDate: month?.date ?? null,
          monthMissing: month?.missing ?? false,
          monthClamped: month?.clamped ?? false,
          monthInWeek: month?.inWeek ?? false,
          monthLabel: category.monthAnchor ? monthAnchorLabel(category.monthAnchor) : null,
        };
      }),
    },
  };
}

function monthInWeek(
  anchor: NonNullable<PlanCategory["monthAnchor"]>,
  dates: string[],
  months: string[],
): { date: string | null; clamped: boolean; missing: boolean; inWeek: boolean } {
  const resolved = months.map((token) => {
    const [year, month] = token.split("-").map(Number);
    return resolveMonthDate(anchor, year ?? 0, month ?? 1);
  });
  const inside = resolved.find((item) => item.date && dates.includes(item.date));
  if (inside?.date) return { date: inside.date, clamped: inside.clamped, missing: false, inWeek: true };
  const any = resolved.find((item) => item.date);
  if (any?.date) return { date: any.date, clamped: any.clamped, missing: false, inWeek: false };
  return { date: null, clamped: false, missing: true, inWeek: false };
}

async function loadPlanView(scope: ReturnType<typeof planScope>, date: string) {
  const zone = agendaTimeZone();
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const period = planPeriod(scope, anchor);
  const file = calendarPolicyPath(profileId());
  const gateway = createEventKitGateway(file);
  const [discovered, policy, blockFile, stored] = await Promise.all([
    gateway.catalog(),
    loadCalendarPolicy(file),
    loadAgendaBlocks(profileId()),
    loadStoredPlan(scope, period.start, profileId()),
  ]);
  const readable = readableCalendars(mergeCalendarAccess(discovered, policy).sources);
  const open = new Set(readable.map((calendar) => calendar.id));
  const [year, month, day] = period.start.split("-").map(Number);
  const after = shiftDate(period.end, 1).split("-").map(Number);
  const events = await gateway.events({
    start: zonedDateTime(zone, year ?? 0, month ?? 1, day ?? 1, 0, 0).toISOString(),
    end: zonedDateTime(zone, after[0] ?? 0, after[1] ?? 1, after[2] ?? 1, 0, 0).toISOString(),
  });
  const calendarLines = events.flatMap((event) => {
    if (!open.has(event.calendarId)) return [];
    const line = eventPlanLine(event, zone);
    return line && period.dates.includes(line.date) ? [line] : [];
  });
  const saved = (stored?.items ?? []).filter((line) => period.dates.includes(line.date));
  return {
    period,
    blocks: blockFile.blocks,
    calendars: readable
      .filter((calendar) => calendar.access === "write")
      .map((calendar) => ({ id: calendar.id, title: calendar.title, sourceTitle: calendar.sourceTitle })),
    items: sortPlanLines(mergePlan(calendarLines, saved)),
    chat: stored?.chat ?? [],
    skipOverlapIds: readable.filter((calendar) => calendar.ignoreOverlaps).map((calendar) => calendar.id),
  };
}

function eventPlanLine(event: CalendarEvent, zone: string): PlanLine {
  const date = dateInZone(event.start, zone);
  return {
    key: event.id,
    eventId: event.id,
    date,
    start: event.allDay ? "00:00" : clockLabel(event.start, zone),
    end: event.allDay ? "23:59" : clockLabel(event.end, zone),
    title: event.title,
    calendarId: event.calendarId,
    origin: "calendar",
    dirty: false,
  };
}

function clockLabel(iso: string, zone: string): string {
  const minutes = minutesInZone(iso, zone);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function planSpan(line: PlanLine, zone: string): { start: string; end: string } | null {
  const start = clockOnPlanDate(line.date, line.start, zone);
  let end = clockOnPlanDate(line.date, line.end, zone);
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);
  if (end.getTime() <= start.getTime()) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

function planItemsForModel(lines: PlanLine[], skipOverlapIds: ReadonlySet<string>): string {
  const describe = (line: PlanLine) =>
    `key=${line.key} eventId=${line.eventId ?? ""} ${line.date} ${line.start}–${line.end} calendar=${line.calendarId} ${line.title}`;
  const blocking = lines.filter((line) => !skipOverlapIds.has(line.calendarId)).map(describe);
  const skipped = lines.filter((line) => skipOverlapIds.has(line.calendarId)).map(describe);
  return [
    `Blocking items:\n${blocking.join("\n") || "none"}`,
    skipped.length ? `Visible only, these skip overlaps and do not reduce open time:\n${skipped.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function resolvePlanCalendar(
  value: string,
  calendars: { id: string; title: string }[],
  blocks: AgendaTimeBlock[],
  date: string,
  start: string,
): string {
  if (calendars.some((calendar) => calendar.id === value)) return value;
  const named = calendars.find((calendar) => calendar.title.toLowerCase() === value.toLowerCase());
  if (named) return named.id;
  const block = blocks.find((candidate) => lineFitsBlock({ date, start }, candidate));
  if (block && calendars.some((calendar) => calendar.id === block.calendarId)) return block.calendarId;
  return calendars.length === 1 ? calendars[0]!.id : "";
}

async function writableCalendars() {
  return (await calendarAccess(calendarPolicyPath(profileId()))).writable;
}

async function calendarAccess(file: string) {
  const gateway = createEventKitGateway(file);
  const [discovered, policy] = await Promise.all([gateway.catalog(), loadCalendarPolicy(file)]);
  const sources = mergeCalendarAccess(discovered, policy).sources;
  return {
    writable: readableCalendars(sources).filter((calendar) => calendar.access === "write"),
    skipOverlapIds: new Set(
      sources.flatMap((source) =>
        source.calendars.filter((calendar) => calendar.ignoreOverlaps).map((calendar) => calendar.id),
      ),
    ),
  };
}

function splitDate(isoDate: string): [number, number, number] {
  const [year, month, day] = isoDate.split("-").map(Number);
  return [year ?? 0, month ?? 1, day ?? 1];
}

function dayLabel(isoDate: string): string {
  const [year, month, day] = splitDate(isoDate);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function minutesInZone(iso: string, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const bag = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = bag.hour === "24" ? 0 : Number(bag.hour);
  return hour * 60 + Number(bag.minute);
}

function dateInZone(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function clockOnDate(date: string, hhmm: string, zone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  return zonedDateTime(zone, year ?? 0, month ?? 1, day ?? 1, hour ?? 0, minute ?? 0);
}

function clockOnDay(anchor: string, hhmm: string, zone: string): Date {
  const [hour, minute] = hhmm.split(":").map(Number);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const bag = Object.fromEntries(fmt.formatToParts(new Date(anchor)).map((part) => [part.type, part.value]));
  return zonedDateTime(zone, Number(bag.year), Number(bag.month), Number(bag.day), hour, minute);
}

/** POST /agenda/voice — hand a finished reply to the live Speech Engine session. */
agendaUiRouter.post("/voice", async (c) => {
  if (!isSpeechEngineStack()) {
    return c.json({ error: "Alfred's voice is the Speech Engine from make alfred VOICE=live2." }, 503);
  }
  let body: { text?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  primeVerbatimSpeech(text);
  return c.json({ ok: true });
});

/** POST /agenda/ear — Agenda is the screen in front, so the next spoken turn uses this view. */
agendaUiRouter.post("/ear", async (c) => {
  let body: { active?: unknown; view?: unknown; unified?: unknown; date?: unknown };
  try {
    body = (await c.req.json()) as { active?: unknown; view?: unknown; unified?: unknown; date?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (body.active === false) {
    setAgendaEar(null);
    return c.json({ ok: true });
  }
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined;
  setAgendaEar({ view: agendaViewFrom(body.view), unified: body.unified === true, date });
  return c.json({ ok: true });
});

/** POST /agenda/say — typed text, with the agenda view attached. */
agendaUiRouter.post("/say", async (c) => {
  let body: { text?: unknown; view?: unknown; unified?: unknown; date?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown; view?: unknown; unified?: unknown; date?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required" }, 400);
  const date = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined;
  try {
    const assistantText = await answerAgendaTurn({
      text,
      view: agendaViewFrom(body.view),
      unified: body.unified === true,
      date,
    });
    return c.json({ assistantText });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
