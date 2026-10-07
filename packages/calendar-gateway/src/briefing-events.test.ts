import { describe, expect, it } from "vitest";
import { loadBriefingAgendaEvents } from "./briefing-events.js";
import type { CalendarPolicy, DiscoveredCalendar } from "./policy.js";

const timeZone = "America/New_York";

const discovered: DiscoveredCalendar[] = [
  {
    id: "work",
    title: "Devon work",
    color: null,
    writable: true,
    sourceIdentifier: "icloud",
    sourceTitle: "Personal iCloud",
    sourceType: "caldav",
  },
  {
    id: "personal",
    title: "Devon Personal",
    color: null,
    writable: true,
    sourceIdentifier: "icloud",
    sourceTitle: "Personal iCloud",
    sourceType: "caldav",
  },
  {
    id: "closed",
    title: "Family",
    color: null,
    writable: false,
    sourceIdentifier: "icloud",
    sourceTitle: "Personal iCloud",
    sourceType: "caldav",
  },
];

const policy: CalendarPolicy = {
  version: 1,
  calendars: {
    work: { access: "write", title: "Devon work", sourceIdentifier: "icloud", sourceTitle: "Personal iCloud" },
    personal: { access: "read", title: "Devon Personal", sourceIdentifier: "icloud", sourceTitle: "Personal iCloud" },
    closed: { access: "none", title: "Family", sourceIdentifier: "icloud", sourceTitle: "Personal iCloud" },
  },
};

describe("loadBriefingAgendaEvents", () => {
  it("keeps today's events on the selected readable calendars", async () => {
    const events = await loadBriefingAgendaEvents({
      policyPath: "/tmp/unused-calendar-access.json",
      calendarIds: ["work", "closed"],
      timeZone,
      now: new Date("2026-10-07T14:00:00.000Z"),
      policy,
      gateway: {
        async catalog() {
          return discovered;
        },
        async events() {
          return [
            {
              id: "1",
              title: "USPTO",
              start: "2026-10-07T16:00:00.000Z",
              end: "2026-10-07T22:15:00.000Z",
              allDay: false,
              calendarId: "work",
              calendarTitle: "Devon work",
              sourceTitle: "Personal iCloud",
            },
            {
              id: "2",
              title: "Lunch",
              start: "2026-10-07T16:30:00.000Z",
              end: "2026-10-07T17:00:00.000Z",
              allDay: false,
              calendarId: "personal",
              calendarTitle: "Devon Personal",
              sourceTitle: "Personal iCloud",
            },
            {
              id: "3",
              title: "USPTO",
              start: "2026-10-08T16:00:00.000Z",
              end: "2026-10-08T21:00:00.000Z",
              allDay: false,
              calendarId: "work",
              calendarTitle: "Devon work",
              sourceTitle: "Personal iCloud",
            },
            {
              id: "4",
              title: "Storytime",
              start: "2026-10-07T15:00:00.000Z",
              end: "2026-10-07T16:00:00.000Z",
              allDay: false,
              calendarId: "closed",
              calendarTitle: "Family",
              sourceTitle: "Personal iCloud",
            },
          ];
        },
      },
    });
    expect(events.map((event) => event.title)).toEqual(["USPTO"]);
    expect(events[0]?.calendarTitle).toBe("Devon work");
  });
});
