import { describe, expect, it } from "vitest";
import {
  claimedWeeklyHours,
  fillBlockHours,
  placeSession,
  resolveMonthDate,
  splitMinutes,
  totalClaimedHours,
  type MonthAnchor,
} from "./standard-plan.js";

describe("claimed weekly hours", () => {
  it("scales a day by seven and a month by 12/52", () => {
    expect(claimedWeeklyHours({ cadence: "day", hours: 2 })).toBe(14);
    expect(claimedWeeklyHours({ cadence: "week", hours: 40 })).toBe(40);
    expect(claimedWeeklyHours({ cadence: "fortnight", hours: 8 })).toBe(4);
    expect(claimedWeeklyHours({ cadence: "month", hours: 4 })).toBeCloseTo((4 * 12) / 52);
    expect(
      totalClaimedHours([
        { cadence: "day", hours: 1 },
        { cadence: "week", hours: 5 },
        { cadence: "month", hours: 13 },
      ]),
    ).toBeCloseTo(7 + 5 + (13 * 12) / 52);
  });
});

describe("resolveMonthDate", () => {
  it("uses the first day, the last day, and a day number", () => {
    expect(resolveMonthDate({ kind: "month-edge", edge: "first" }, 2026, 10)).toMatchObject({
      date: "2026-10-01",
      clamped: false,
    });
    expect(resolveMonthDate({ kind: "month-edge", edge: "last" }, 2026, 10)).toMatchObject({
      date: "2026-10-31",
    });
    expect(resolveMonthDate({ kind: "month-day", day: 13 }, 2026, 10)).toMatchObject({ date: "2026-10-13" });
  });

  it("clamps a day number to the end of a short month", () => {
    expect(resolveMonthDate({ kind: "month-day", day: 31 }, 2026, 2)).toEqual({
      date: "2026-02-28",
      clamped: true,
      missing: false,
    });
  });

  it("finds the 2nd Tuesday and reports a 5th weekday the month does not have", () => {
    const secondTuesday: MonthAnchor = { kind: "nth-weekday", n: 2, weekday: 2 };
    expect(resolveMonthDate(secondTuesday, 2026, 10)).toMatchObject({ date: "2026-10-13", missing: false });
    const fifthTuesday: MonthAnchor = { kind: "nth-weekday", n: 5, weekday: 2 };
    expect(resolveMonthDate(fifthTuesday, 2026, 10)).toEqual({ date: null, clamped: false, missing: true });
  });

  it("finds the last Friday", () => {
    expect(resolveMonthDate({ kind: "nth-weekday", n: -1, weekday: 5 }, 2026, 10)).toMatchObject({
      date: "2026-10-30",
      missing: false,
    });
  });
});

describe("fillBlockHours", () => {
  const dates = ["2026-10-12", "2026-10-13"];

  it("fills from the start and works around an event already in the block", () => {
    const filled = fillBlockHours({
      dates,
      blockStart: 9 * 60,
      blockEnd: 17 * 60,
      requests: [{ categoryId: "work", minutes: 8 * 60 }],
      busyOn: (date) => (date === dates[0] ? [{ startMin: 12 * 60, endMin: 13 * 60 }] : []),
    });
    expect(filled.slices).toEqual([
      { categoryId: "work", date: dates[0], startMin: 9 * 60, endMin: 12 * 60 },
      { categoryId: "work", date: dates[0], startMin: 13 * 60, endMin: 17 * 60 },
      { categoryId: "work", date: dates[1], startMin: 9 * 60, endMin: 10 * 60 },
    ]);
    expect(filled.unplaced).toEqual([]);
  });

  it("lets the next category continue where the first one stopped", () => {
    const filled = fillBlockHours({
      dates,
      blockStart: 9 * 60,
      blockEnd: 12 * 60,
      requests: [
        { categoryId: "deep", minutes: 4 * 60 },
        { categoryId: "admin", minutes: 2 * 60 },
      ],
      busyOn: () => [],
    });
    expect(filled.slices).toEqual([
      { categoryId: "deep", date: dates[0], startMin: 9 * 60, endMin: 12 * 60 },
      { categoryId: "deep", date: dates[1], startMin: 9 * 60, endMin: 10 * 60 },
      { categoryId: "admin", date: dates[1], startMin: 10 * 60, endMin: 12 * 60 },
    ]);
    expect(filled.unplaced).toEqual([]);
  });

  it("keeps a short slice for the leftover and reports hours that do not fit", () => {
    const short = fillBlockHours({
      dates: [dates[0]!],
      blockStart: 9 * 60,
      blockEnd: 17 * 60,
      requests: [{ categoryId: "work", minutes: 10 * 60 }],
      busyOn: () => [],
    });
    expect(short.slices).toEqual([
      { categoryId: "work", date: dates[0], startMin: 9 * 60, endMin: 17 * 60 },
    ]);
    expect(short.unplaced).toEqual([{ categoryId: "work", minutes: 2 * 60 }]);

    const leftover = fillBlockHours({
      dates,
      blockStart: 9 * 60,
      blockEnd: 17 * 60,
      requests: [{ categoryId: "work", minutes: 10 * 60 }],
      busyOn: () => [],
    });
    expect(leftover.slices).toEqual([
      { categoryId: "work", date: dates[0], startMin: 9 * 60, endMin: 17 * 60 },
      { categoryId: "work", date: dates[1], startMin: 9 * 60, endMin: 11 * 60 },
    ]);
    expect(leftover.unplaced).toEqual([]);
  });
});

describe("placeSession", () => {
  const block = { start: "09:00", end: "12:00", repeat: "weekdays" as const, days: [] };
  const dates = ["2026-10-10", "2026-10-11", "2026-10-12"];

  it("offers the next day the block runs when the chosen day is off", () => {
    const placed = placeSession({
      date: "2026-10-10",
      block,
      minutes: 60,
      dates,
      busyOn: () => [],
    });
    expect(placed.status).toBe("off-day");
    expect(placed.next).toEqual({ date: "2026-10-12", startMin: 9 * 60 });
  });
});

describe("splitMinutes", () => {
  it("divides a category across the blocks that host it", () => {
    expect(splitMinutes(40 * 60, 2)).toEqual([20 * 60, 20 * 60]);
    expect(splitMinutes(5, 2)).toEqual([3, 2]);
    expect(splitMinutes(30, 1)).toEqual([30]);
  });
});
