import { describe, expect, it } from "vitest";
import type { AgendaTimeBlock } from "./agenda-blocks.js";
import {
  applyChatItems,
  sortPlanLines,
  assignDefaultPlanDate,
  defaultPlanDate,
  lineFitsBlock,
  linesToCommit,
  mergePlan,
  messageNamesDate,
  durationFromMessage,
  ensureRequestedPlanItem,
  nextOpenHour,
  openPlanGaps,
  placeNewItemsFromClock,
  titleFromPlanRequest,
  parsePlanReply,
  planPeriod,
  shiftPlanAnchor,
  type PlanLine,
} from "./agenda-plan.js";

const block: AgendaTimeBlock = {
  id: "morning",
  name: "Morning",
  calendarId: "personal",
  start: "08:00",
  end: "12:00",
  repeat: "weekends",
  days: [],
  categoryIds: [],
};

function line(partial: Partial<PlanLine> & Pick<PlanLine, "title">): PlanLine {
  return {
    key: partial.key ?? partial.title,
    date: partial.date ?? "2026-10-10",
    start: partial.start ?? "09:00",
    end: partial.end ?? "10:00",
    title: partial.title,
    calendarId: partial.calendarId ?? "personal",
    origin: partial.origin ?? "calendar",
    dirty: partial.dirty ?? false,
    eventId: partial.eventId,
  };
}

describe("plan period", () => {
  it("uses Saturday and Sunday of the week that contains the anchor", () => {
    const period = planPeriod("weekend", "2026-10-07");
    expect(period.dates).toEqual(["2026-10-10", "2026-10-11"]);
    expect(planPeriod("week", "2026-10-07").dates[0]).toBe("2026-10-04");
    expect(planPeriod("day", "2026-10-07").dates).toEqual(["2026-10-07"]);
    expect(shiftPlanAnchor("day", "2026-10-07", 1)).toBe("2026-10-08");
    expect(shiftPlanAnchor("weekend", "2026-10-07", 1)).toBe("2026-10-14");
  });
});

describe("plan lines", () => {
  it("keeps a calendar row dim until a saved edit differs", () => {
    const calendar = [line({ title: "USPTO", eventId: "evt-1", start: "12:00", end: "18:15" })];
    const saved = [line({ title: "USPTO", eventId: "evt-1", start: "12:00", end: "17:00", dirty: true })];
    const merged = mergePlan(calendar, saved);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.dirty).toBe(true);
    expect(mergePlan(calendar, [line({ title: "USPTO", eventId: "evt-1", start: "12:00", end: "18:15" })])[0]?.dirty).toBe(false);
  });

  it("keeps drafts and drops a saved row whose event is gone", () => {
    const merged = mergePlan(
      [line({ title: "USPTO", eventId: "evt-1" })],
      [line({ title: "Laundry", origin: "draft", eventId: undefined }), line({ title: "Gone", eventId: "missing" })],
    );
    expect(merged.map((item) => item.title)).toEqual(["USPTO", "Laundry"]);
  });

  it("applies a chat change to the named event and adds the other activities as their own rows", () => {
    const current = [
      line({ title: "Laundry", eventId: "laundry", start: "10:00", end: "12:00" }),
      line({ title: "Movie", eventId: "movie", start: "19:00", end: "21:00" }),
    ];
    const next = applyChatItems(
      current,
      [
        { eventId: "laundry", date: "2026-10-10", start: "10:00", end: "11:00", title: "Laundry", calendarId: "personal" },
        { eventId: "movie", date: "2026-10-10", start: "20:00", end: "22:00", title: "Movie", calendarId: "personal" },
        { date: "2026-10-10", start: "13:00", end: "14:00", title: "Haircut", calendarId: "personal" },
      ],
      () => "draft-1",
    );
    expect(next.map((item) => [item.title, item.start, item.end, item.dirty, item.eventId ?? ""])).toEqual([
      ["Laundry", "10:00", "11:00", true, "laundry"],
      ["Haircut", "13:00", "14:00", true, ""],
      ["Movie", "20:00", "22:00", true, "movie"],
    ]);
  });

  it("sorts a day by start time when later notes were added first", () => {
    const sorted = sortPlanLines([
      line({ title: "Library Storytime", start: "13:00", end: "13:30" }),
      line({ title: "SLO rep class", start: "13:00", end: "14:00" }),
      line({ title: "Portuguese heritage", start: "15:00", end: "23:00" }),
      line({ title: "Alex baby shower", start: "18:00", end: "19:00" }),
      line({ title: "Visit two Alexandria", start: "14:00", end: "15:30", origin: "draft" }),
      line({ title: "Talk to Matty", start: "22:15", end: "23:15", origin: "draft" }),
      line({ title: "Work on Helmsman", start: "19:00", end: "20:00", origin: "draft" }),
    ]);
    expect(sorted.map((item) => item.title)).toEqual([
      "Library Storytime",
      "SLO rep class",
      "Visit two Alexandria",
      "Portuguese heritage",
      "Alex baby shower",
      "Work on Helmsman",
      "Talk to Matty",
    ]);
  });

  it("commits a new row as a create and a changed calendar row as an update", () => {
    const actions = linesToCommit([
      line({ title: "USPTO", eventId: "evt-1", dirty: false }),
      line({ title: "USPTO", eventId: "evt-1", start: "13:00", dirty: true }),
      line({ title: "Haircut", origin: "draft", eventId: undefined }),
      line({ title: "   ", origin: "draft", eventId: undefined }),
    ]);
    expect(actions.update.map((item) => item.start)).toEqual(["13:00"]);
    expect(actions.create.map((item) => item.title)).toEqual(["Haircut"]);
  });

  it("places a row under the block that contains its start", () => {
    expect(lineFitsBlock({ date: "2026-10-10", start: "09:30" }, block)).toBe(true);
    expect(lineFitsBlock({ date: "2026-10-09", start: "09:30" }, block)).toBe(false);
    expect(lineFitsBlock({ date: "2026-10-10", start: "13:00" }, block)).toBe(false);
  });

  it("reads a plan reply that wraps several items", () => {
    const parsed = parsePlanReply(
      '```json\n{"reply":"Added three.","items":[{"title":"Haircut","date":"2026-10-10","start":"13:00","end":"14:00","calendarId":"personal"},{"title":"Movie","date":"2026-10-10","start":"7:00","end":"21:00"}]}\n```',
    );
    expect(parsed?.reply).toBe("Added three.");
    expect(parsed?.items).toHaveLength(2);
    expect(parsed?.items[1]?.start).toBe("07:00");
  });

  it("puts a new item on today when the note does not name a day", () => {
    const week = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
    expect(messageNamesDate("do some laundry this evening")).toBe(false);
    expect(messageNamesDate("haircut on Monday")).toBe(true);
    expect(defaultPlanDate({ message: "do some laundry", dates: week, today: "2026-10-10" })).toBe("2026-10-10");
    expect(defaultPlanDate({ message: "do some laundry", dates: week, today: "2026-10-10", selected: "2026-10-07" })).toBe("2026-10-07");
    expect(defaultPlanDate({ message: "haircut on Monday", dates: week, today: "2026-10-10" })).toBeNull();
    const current = [line({ title: "USPTO", eventId: "evt-1", date: "2026-10-04" })];
    const placed = assignDefaultPlanDate(
      current,
      [
        { date: "2026-10-04", start: "09:00", end: "10:00", title: "Laundry", calendarId: "personal" },
        { eventId: "evt-1", date: "2026-10-04", start: "12:00", end: "18:00", title: "USPTO", calendarId: "work" },
      ],
      "2026-10-10",
    );
    expect(placed.map((item) => [item.title, item.date])).toEqual([
      ["Laundry", "2026-10-10"],
      ["USPTO", "2026-10-04"],
    ]);
  });

  it("lets a new item sit on top of a calendar that skips overlaps", () => {
    const gaps = openPlanGaps(
      [
        { date: "2026-10-10", start: "09:00", end: "10:00", calendarId: "holidays" },
        { date: "2026-10-10", start: "12:00", end: "13:00", calendarId: "work" },
      ],
      "2026-10-10",
      new Set(["holidays"]),
      8 * 60,
      14 * 60,
    );
    expect(gaps).toEqual([
      { start: 8 * 60, end: 12 * 60 },
      { start: 13 * 60, end: 14 * 60 },
    ]);
  });

  it("moves a new item off midnight onto the next open hour", () => {
    const now = 12 * 60 + 53;
    expect(nextOpenHour(now, 90, [])).toBe(13 * 60);
    const placed = placeNewItemsFromClock({
      current: [
        line({ title: "Storytime", eventId: "story", date: "2026-10-10", start: "13:00", end: "13:30", calendarId: "family" }),
        line({ title: "USPTO", eventId: "work", date: "2026-10-10", start: "15:00", end: "18:00", calendarId: "work" }),
      ],
      incoming: [
        { date: "2026-10-10", start: "00:00", end: "01:30", title: "Library visit", calendarId: "personal" },
        { eventId: "work", date: "2026-10-10", start: "09:00", end: "12:00", title: "USPTO", calendarId: "work" },
      ],
      today: "2026-10-10",
      nowMin: now,
      message: "I need to visit two libraries today, about an hour and a half",
      skipOverlapIds: new Set(["family"]),
    });
    expect(placed.map((item) => [item.title, item.start, item.end])).toEqual([
      ["Library visit", "13:00", "14:30"],
      ["USPTO", "09:00", "12:00"],
    ]);
  });

  it("pulls a new item forward when the model hid it behind a skip-overlap calendar", () => {
    const placed = placeNewItemsFromClock({
      current: [
        line({ title: "Storytime", eventId: "story", date: "2026-10-10", start: "13:00", end: "14:00", calendarId: "family" }),
        line({ title: "Heritage", eventId: "heritage", date: "2026-10-10", start: "15:00", end: "23:00", calendarId: "family" }),
      ],
      incoming: [{ date: "2026-10-10", start: "23:00", end: "00:30", title: "Library visit", calendarId: "personal" }],
      today: "2026-10-10",
      nowMin: 12 * 60 + 57,
      message: "I need to visit two libraries today, about an hour and a half",
      skipOverlapIds: new Set(["family"]),
    });
    expect(placed[0]?.start).toBe("13:00");
    expect(placed[0]?.end).toBe("14:30");
  });

  it("places the requested item when the model says the skip-overlap events leave no gap", () => {
    const message = "I need to goto two Alexandria libraries today to get a library card, give me about an hour and a half for it";
    const reply = "I couldn't schedule the library visit because no 90-minute gap is available after 13:00.";
    expect(durationFromMessage(message)).toBe(90);
    expect(titleFromPlanRequest(message, reply)).toBe("Library visit");
    const family = [
      line({ title: "Library Storytime", eventId: "story", date: "2026-10-10", start: "13:00", end: "13:30", calendarId: "family" }),
      line({ title: "SLO rep class", eventId: "slo", date: "2026-10-10", start: "13:00", end: "14:00", calendarId: "family" }),
      line({ title: "Portuguese heritage", eventId: "heritage", date: "2026-10-10", start: "15:00", end: "23:00", calendarId: "family" }),
      line({ title: "Alex baby shower", eventId: "shower", date: "2026-10-10", start: "18:00", end: "19:00", calendarId: "family" }),
    ];
    const placed = ensureRequestedPlanItem({
      current: family,
      incoming: [],
      today: "2026-10-10",
      day: "2026-10-10",
      nowMin: 12 * 60 + 57,
      message,
      reply,
      skipOverlapIds: new Set(["family"]),
    });
    expect(placed.reply).toBe("Scheduled Library visit at 1:00 PM.");
    expect(placed.items.map((item) => [item.title, item.start, item.end])).toEqual([["Library visit", "13:00", "14:30"]]);
  });

  it("keeps a real conflict when a calendar that counts is full", () => {
    const placed = ensureRequestedPlanItem({
      current: [line({ title: "Work", eventId: "work", date: "2026-10-10", start: "13:00", end: "23:30", calendarId: "work" })],
      incoming: [],
      today: "2026-10-10",
      day: "2026-10-10",
      nowMin: 12 * 60 + 57,
      message: "I need an hour and a half for the library",
      reply: "I couldn't schedule the library visit because no 90-minute gap is available after 13:00.",
      skipOverlapIds: new Set(["family"]),
    });
    expect(placed.items).toEqual([]);
    expect(placed.reply).toMatch(/couldn't schedule/);
  });

  it("does not invent an item when the note is only editing what is already there", () => {
    const placed = ensureRequestedPlanItem({
      current: [line({ title: "Laundry", key: "laundry", date: "2026-10-10", start: "13:00", end: "14:00" })],
      incoming: [],
      today: "2026-10-10",
      day: "2026-10-10",
      nowMin: 12 * 60,
      message: "make the laundry shorter",
      reply: "Shortened laundry.",
      skipOverlapIds: new Set(),
    });
    expect(placed.items).toEqual([]);
  });

  it("keeps an evening item where the model put it", () => {
    const placed = placeNewItemsFromClock({
      current: [],
      incoming: [{ date: "2026-10-10", start: "19:00", end: "21:00", title: "Movie", calendarId: "personal" }],
      today: "2026-10-10",
      nowMin: 12 * 60 + 57,
      message: "movie this evening",
      skipOverlapIds: new Set(["family"]),
    });
    expect(placed[0]?.start).toBe("19:00");
  });

  it("keeps a new item at a time the user named, even earlier than now", () => {
    const placed = placeNewItemsFromClock({
      current: [],
      incoming: [{ date: "2026-10-10", start: "09:00", end: "10:00", title: "Laundry", calendarId: "personal" }],
      today: "2026-10-10",
      nowMin: 15 * 60,
      message: "I already did laundry at 9",
      skipOverlapIds: new Set(),
    });
    expect(placed[0]?.start).toBe("09:00");
  });
});
