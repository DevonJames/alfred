import { describe, expect, it } from "vitest";
import type { CalendarGateway } from "./helper.js";
import {
  applyPreparedRearrange,
  approvalAddsDetail,
  looksLikeScheduleChange,
  parseRearrangeReply,
  prepareRearrange,
  scheduleReplyStance,
  uncommittedPlanSpeech,
  type ScheduleCalendar,
  type ScheduleEvent,
} from "./rearrange.js";

const personal: ScheduleCalendar = {
  id: "cal-personal",
  title: "Devon Personal",
  sourceTitle: "Personal iCloud",
  writable: true,
};
const family: ScheduleCalendar = {
  id: "cal-family",
  title: "Family",
  sourceTitle: "Personal iCloud",
  writable: false,
};

const lunch: ScheduleEvent = {
  id: "evt-lunch",
  title: "Lunch",
  start: "2026-09-27T16:00:00.000Z",
  end: "2026-09-27T16:45:00.000Z",
  allDay: false,
  calendarId: personal.id,
  calendarTitle: personal.title,
  writable: true,
};

describe("schedule change detection", () => {
  it("treats a squeeze or a vague move as a judgment, and a finished clock time as a normal command", () => {
    expect(looksLikeScheduleChange("can I squeeze in a 20 minute walk after lunch")).toBe(true);
    expect(looksLikeScheduleChange("move lunch later")).toBe(true);
    expect(looksLikeScheduleChange("push everything after 2 back 30 minutes")).toBe(true);
    expect(looksLikeScheduleChange("Can you move some things around to make that work?")).toBe(true);
    expect(looksLikeScheduleChange("adjust the schedule so I can fit a call")).toBe(true);
    expect(looksLikeScheduleChange("move lunch to 3:00 PM")).toBe(false);
    expect(looksLikeScheduleChange("when is lunch")).toBe(false);
  });

  it("accepts a short yes or no and ignores a yes that adds a condition", () => {
    expect(scheduleReplyStance("Yes please.")).toBe("yes");
    expect(scheduleReplyStance("Yes, I did. I told you all that information. Make it for about 30 minutes")).toBe("yes");
    expect(approvalAddsDetail("Yes, I did. I told you all that information. Make it for about 30 minutes")).toBe(true);
    expect(approvalAddsDetail("Yes please.")).toBe(false);
    expect(scheduleReplyStance("no, leave it")).toBe("no");
    expect(scheduleReplyStance("yes but only move lunch")).toBe("other");
    expect(scheduleReplyStance("when is dinner")).toBe("other");
    expect(uncommittedPlanSpeech("I'll adjust the afternoon.")).toMatch(/haven't changed/);
  });
});

describe("prepareRearrange", () => {
  it("keeps the event's length and refuses a read-only calendar", () => {
    const familyEvent: ScheduleEvent = { ...lunch, id: "evt-family", title: "Soccer", writable: false, calendarId: family.id, calendarTitle: family.title };
    const locked = prepareRearrange(
      [{ op: "move", id: familyEvent.id, start: "2026-09-27T17:00:00.000Z", end: "2026-09-27T18:00:00.000Z" }],
      [familyEvent],
      [personal, family],
    );
    expect(locked.ok).toBe(false);

    const ready = prepareRearrange(
      [{ op: "move", id: lunch.id, start: "2026-09-27T17:00:00.000Z", end: "2026-09-27T19:00:00.000Z" }],
      [lunch],
      [personal, family],
    );
    expect(ready.ok).toBe(true);
    if (ready.ok) {
      expect(ready.changes[0]?.start).toBe("2026-09-27T17:00:00.000Z");
      expect(ready.changes[0]?.end).toBe("2026-09-27T17:45:00.000Z");
    }

    const flexed = prepareRearrange(
      [{ op: "move", id: lunch.id, flex: true, start: "2026-09-27T17:00:00.000Z", end: "2026-09-27T17:20:00.000Z" }],
      [lunch],
      [personal, family],
    );
    expect(flexed.ok).toBe(true);
    if (flexed.ok) expect(flexed.changes[0]?.end).toBe("2026-09-27T17:20:00.000Z");

    const erased = prepareRearrange(
      [{ op: "move", id: lunch.id, flex: true, start: "2026-09-27T17:00:00.000Z", end: "2026-09-27T17:05:00.000Z" }],
      [lunch],
      [personal, family],
    );
    expect(erased.ok).toBe(false);
  });

  it("parses a proposal and applies it only through the gateway", async () => {
    const parsed = parseRearrangeReply(`\`\`\`json
{"speech":"I can if I push lunch to 1:00 PM. Want me to?","proposal":{"changes":[
  {"op":"move","id":"evt-lunch","start":"2026-09-27T17:00:00.000Z","end":"2026-09-27T17:45:00.000Z"},
  {"op":"create","title":"Walk","calendarId":"cal-personal","start":"2026-09-27T16:00:00.000Z","end":"2026-09-27T16:20:00.000Z"}
]}}
\`\`\``);
    expect(parsed?.speech).toMatch(/Want me to/);
    const ready = prepareRearrange(parsed!.changes!, [lunch], [personal, family]);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    const updates: Array<{ eventId: string; start: string; end: string }> = [];
    const creates: string[] = [];
    const gateway: CalendarGateway = {
      async catalog() {
        return [];
      },
      async events() {
        return [];
      },
      async create(input) {
        creates.push(input.title);
        return {
          id: "new",
          title: input.title,
          start: input.start,
          end: input.end,
          allDay: false,
          calendarId: input.calendarId,
          calendarTitle: "Devon Personal",
          sourceTitle: "Personal iCloud",
        };
      },
      async update(input) {
        updates.push(input);
        return { ...lunch, start: input.start, end: input.end };
      },
      async delete() {},
    };
    const speech = await applyPreparedRearrange({
      changes: ready.changes,
      gateway,
      timeZone: "America/New_York",
    });
    expect(updates).toEqual([
      { eventId: "evt-lunch", start: "2026-09-27T17:00:00.000Z", end: "2026-09-27T17:45:00.000Z" },
    ]);
    expect(creates).toEqual(["Walk"]);
    expect(speech).toMatch(/Done/);
    expect(speech).toMatch(/Lunch/);
    expect(speech).toMatch(/Walk/);
  });
});
