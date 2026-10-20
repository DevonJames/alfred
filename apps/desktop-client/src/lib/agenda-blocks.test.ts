import { describe, expect, it } from "vitest";
import {
  blockRunsOn,
  cleanAgendaBlock,
  nextFittingDay,
  placeInBlock,
  type BusySpan,
} from "./agenda-blocks.js";

const work = { start: "09:00", end: "12:00", repeat: "weekdays" as const, days: [] };

function span(partial: Partial<BusySpan> & Pick<BusySpan, "startMin" | "endMin">): BusySpan {
  return { id: partial.id ?? "evt", title: partial.title ?? "Meeting", ...partial };
}

describe("placeInBlock", () => {
  it("starts at the beginning of an empty block", () => {
    expect(
      placeInBlock({ blockStart: 9 * 60, blockEnd: 12 * 60, duration: 30, events: [], reminderIds: [] }),
    ).toMatchObject({ status: "fit", startMin: 9 * 60, endMin: 9 * 60 + 30 });
  });

  it("uses the open stretch before a meeting", () => {
    const placed = placeInBlock({
      blockStart: 9 * 60,
      blockEnd: 12 * 60,
      duration: 30,
      events: [span({ startMin: 10 * 60, endMin: 11 * 60, title: "Standup" })],
      reminderIds: [],
    });
    expect(placed).toMatchObject({ status: "fit", startMin: 9 * 60 });
  });

  it("starts the next reminder after one already placed in the block", () => {
    const placed = placeInBlock({
      blockStart: 9 * 60,
      blockEnd: 12 * 60,
      duration: 30,
      events: [
        span({ id: "rem-1", title: "Call the IRS", startMin: 9 * 60, endMin: 9 * 60 + 30 }),
        span({ id: "meet", title: "Standup", startMin: 10 * 60, endMin: 11 * 60 }),
      ],
      reminderIds: ["rem-1"],
    });
    expect(placed).toMatchObject({ status: "fit", startMin: 9 * 60 + 30, endMin: 10 * 60 });
  });

  it("asks to overlap when nothing long enough is free", () => {
    const placed = placeInBlock({
      blockStart: 9 * 60,
      blockEnd: 12 * 60,
      duration: 90,
      events: [span({ title: "Standup", startMin: 9 * 60 + 30, endMin: 12 * 60 })],
      reminderIds: [],
    });
    expect(placed).toMatchObject({ status: "overlap", overlapTitle: "Standup", startMin: 9 * 60 });
  });
});

describe("block days", () => {
  it("repeats on the chosen kind of day", () => {
    expect(blockRunsOn(work, "2026-10-06")).toBe(true);
    expect(blockRunsOn(work, "2026-10-10")).toBe(false);
    expect(blockRunsOn({ ...work, repeat: "weekends" }, "2026-10-10")).toBe(true);
    expect(blockRunsOn({ ...work, repeat: "custom", days: [2] }, "2026-10-06")).toBe(true);
    expect(blockRunsOn({ ...work, repeat: "all" }, "2026-10-10")).toBe(true);
  });

  it("finds the next weekday that has room", () => {
    const found = nextFittingDay({
      fromDate: "2026-10-10",
      block: work,
      duration: 60,
      reminderIds: [],
      eventsOn: (date) =>
        date === "2026-10-12" ? [span({ startMin: 9 * 60, endMin: 12 * 60, title: "Offsite" })] : [],
    });
    expect(found).toEqual({ date: "2026-10-13", startMin: 9 * 60 });
  });
});

describe("cleanAgendaBlock", () => {
  it("accepts a weekday block and assigns an id", () => {
    const block = cleanAgendaBlock({
      name: "Deep work",
      start: "09:00",
      end: "12:00",
      repeat: "weekdays",
      days: [],
      calendarId: "cal-1",
    });
    expect(block).toMatchObject({
      name: "Deep work",
      start: "09:00",
      end: "12:00",
      repeat: "weekdays",
      calendarId: "cal-1",
    });
    expect(block?.id).toBeTruthy();
  });

  it("rejects inverted clocks", () => {
    expect(
      cleanAgendaBlock({
        name: "Nope",
        start: "14:00",
        end: "10:00",
        repeat: "all",
        days: [],
        calendarId: "cal-1",
      }),
    ).toBeNull();
  });
});
