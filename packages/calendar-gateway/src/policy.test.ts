import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeCalendarAccess, type DiscoveredCalendar } from "./policy.js";
import { loadCalendarPolicy, saveCalendarPolicy } from "./store.js";

const personal: DiscoveredCalendar = {
  id: "cal-family-personal",
  title: "Family",
  color: "#ff0000",
  writable: true,
  sourceIdentifier: "src-personal",
  sourceTitle: "Personal iCloud",
  sourceType: "calDAV",
};

const familyAccount: DiscoveredCalendar = {
  id: "cal-family-shared",
  title: "Family",
  color: "#00ff00",
  writable: true,
  sourceIdentifier: "src-family",
  sourceTitle: "Family iCloud",
  sourceType: "calDAV",
};

const holidays: DiscoveredCalendar = {
  id: "cal-holidays",
  title: "Holidays in United States",
  color: null,
  writable: false,
  sourceIdentifier: "src-web3",
  sourceTitle: "amy@web3wg.org",
  sourceType: "calDAV",
};

describe("mergeCalendarAccess", () => {
  it("leaves unchosen calendars at no access and groups them by account", () => {
    const merged = mergeCalendarAccess([personal, familyAccount, holidays], {
      version: 1,
      calendars: {},
    });
    expect(merged.sources.map((source) => source.sourceTitle)).toEqual([
      "Personal iCloud",
      "Family iCloud",
      "amy@web3wg.org",
    ]);
    expect(merged.sources[0]?.calendars[0]?.access).toBe("none");
    expect(merged.sources[2]?.calendars[0]?.writeEnabled).toBe(false);
  });

  it("keeps a grant when EventKit replaces the calendar id", () => {
    const merged = mergeCalendarAccess([personal], {
      version: 1,
      calendars: {
        "old-id": {
          access: "write",
          title: "Family",
          sourceIdentifier: "src-personal",
          sourceTitle: "Personal iCloud",
        },
      },
    });
    expect(merged.sources[0]?.calendars[0]?.access).toBe("write");
    expect(merged.grants["cal-family-personal"]?.access).toBe("write");
  });

  it("coerces write to read when the calendar cannot be modified", () => {
    const merged = mergeCalendarAccess([holidays], {
      version: 1,
      calendars: {
        "cal-holidays": {
          access: "write",
          title: holidays.title,
          sourceIdentifier: holidays.sourceIdentifier,
          sourceTitle: holidays.sourceTitle,
        },
      },
    });
    expect(merged.sources[0]?.calendars[0]?.access).toBe("read");
    expect(merged.sources[0]?.calendars[0]?.ignoreOverlaps).toBe(false);
  });

  it("keeps skip-overlaps on the calendar when EventKit replaces the id", () => {
    const merged = mergeCalendarAccess([personal], {
      version: 1,
      calendars: {
        "old-id": {
          access: "read",
          title: "Family",
          sourceIdentifier: "src-personal",
          sourceTitle: "Personal iCloud",
          ignoreOverlaps: true,
        },
      },
    });
    expect(merged.sources[0]?.calendars[0]?.ignoreOverlaps).toBe(true);
    expect(merged.grants["cal-family-personal"]?.ignoreOverlaps).toBe(true);
    expect(merged.grants["cal-family-personal"]?.access).toBe("read");
  });

  it("saves skip-overlaps without changing access", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cal-policy-"));
    const file = path.join(dir, "calendar-access.json");
    await saveCalendarPolicy(file, {
      version: 1,
      calendars: {
        "cal-family": {
          access: "read",
          title: "Family",
          sourceIdentifier: "src",
          sourceTitle: "iCloud",
          ignoreOverlaps: true,
        },
      },
    });
    const loaded = await loadCalendarPolicy(file);
    expect(loaded.calendars["cal-family"]?.access).toBe("read");
    expect(loaded.calendars["cal-family"]?.ignoreOverlaps).toBe(true);
  });
});
