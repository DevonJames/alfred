import { describe, expect, it } from "vitest";
import { remindersForBriefing } from "./due.js";
import { mergeReminderAccess, type DiscoveredList } from "./policy.js";

const list = (id: string, title: string, writable = true): DiscoveredList => ({
  id,
  title,
  color: null,
  writable,
  sourceIdentifier: "src",
  sourceTitle: "iCloud",
  sourceType: "calDAV",
});

describe("mergeReminderAccess", () => {
  it("leaves an unchosen list at no access", () => {
    const merged = mergeReminderAccess([list("a", "Personal")], { version: 1, lists: {} });
    expect(merged.sources[0]?.lists[0]?.access).toBe("none");
  });

  it("drops write to read when the list cannot be edited", () => {
    const merged = mergeReminderAccess([list("a", "Birthdays", false)], {
      version: 1,
      lists: {
        a: { access: "write", title: "Birthdays", sourceIdentifier: "src", sourceTitle: "iCloud" },
      },
    });
    expect(merged.sources[0]?.lists[0]?.access).toBe("read");
  });
});

describe("remindersForBriefing", () => {
  const now = new Date("2026-10-05T14:00:00.000Z");

  it("keeps today and overdue items and skips later or undated ones", () => {
    const rows = remindersForBriefing(
      [
        { id: "1", title: "Today", due: "2026-10-05", listId: "a", listTitle: "Personal", completed: false },
        { id: "2", title: "Yesterday", due: "2026-10-04", listId: "a", listTitle: "Personal", completed: false },
        { id: "3", title: "Friday", due: "2026-10-09", listId: "a", listTitle: "Personal", completed: false },
        { id: "4", title: "Someday", due: null, listId: "a", listTitle: "Personal", completed: false },
      ],
      now,
      "America/New_York",
    );
    expect(rows.map((row) => row.title)).toEqual(["Today", "Yesterday"]);
    expect(rows[1]?.overdue).toBe(true);
    expect(rows[0]?.dueToday).toBe(true);
  });
});
