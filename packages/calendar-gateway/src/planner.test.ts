import { describe, expect, it } from "vitest";
import type { CalendarEvent, CalendarGateway } from "./helper.js";
import { agendaDateHeading, agendaNeedsRewrite, agendaRewrite, interpretCalendarTask } from "./planner.js";
import type { CalendarRow } from "./policy.js";
import { runCalendarTask } from "./run.js";

const timeZone = "America/New_York";
const now = new Date("2026-09-26T18:00:00.000Z");

function row(partial: Partial<CalendarRow> & Pick<CalendarRow, "id" | "title" | "sourceTitle">): CalendarRow {
  return {
    color: null,
    writable: true,
    writeEnabled: true,
    access: "write",
    sourceIdentifier: partial.sourceTitle,
    sourceType: "calDAV",
    ...partial,
  };
}

const devon = row({
  id: "devon",
  title: "Devon Personal",
  sourceTitle: "Personal iCloud",
  sourceIdentifier: "personal",
});
const familyPersonal = row({
  id: "family-personal",
  title: "Family",
  sourceTitle: "Personal iCloud",
  sourceIdentifier: "personal",
});
const familyShared = row({
  id: "family-shared",
  title: "Family",
  sourceTitle: "Family iCloud",
  sourceIdentifier: "family",
});

describe("interpretCalendarTask", () => {
  it("lists today when asked what is on the calendar", () => {
    const plan = interpretCalendarTask({
      task: "What's on my calendar today?",
      now,
      timeZone,
      calendars: [devon],
    });
    expect(plan.commands[0]).toMatchObject({ op: "list" });
    const command = plan.commands[0];
    if (command?.op !== "list") throw new Error("expected list");
    expect(new Date(command.start).toISOString()).toBe("2026-09-26T04:00:00.000Z");
    expect(new Date(command.end).toISOString()).toBe("2026-09-27T04:00:00.000Z");
  });

  it("asks which Family calendar when the name is shared across accounts", () => {
    const plan = interpretCalendarTask({
      task: 'Add "Focus" tomorrow at 3pm on Family',
      now,
      timeZone,
      calendars: [familyPersonal, familyShared],
    });
    expect(plan.commands).toEqual([]);
    expect(plan.clarify).toMatch(/Personal iCloud/);
    expect(plan.clarify).toMatch(/Family iCloud/);
  });

  it("creates on the named calendar at the named time", () => {
    const plan = interpretCalendarTask({
      task: 'Add "Focus" tomorrow at 3pm on Devon Personal',
      now,
      timeZone,
      calendars: [devon, familyPersonal],
    });
    expect(plan.commands[0]).toMatchObject({
      op: "create",
      calendarId: "devon",
      title: "Focus",
      start: "2026-09-27T19:00:00.000Z",
    });
  });

  it("refuses to guess a time without AM or PM", () => {
    const plan = interpretCalendarTask({
      task: 'Add "Focus" tomorrow at 3 on Devon Personal',
      now,
      timeZone,
      calendars: [devon],
    });
    expect(plan.commands).toEqual([]);
    expect(plan.clarify).toMatch(/AM or PM/);
  });

  it("adds a timed range written the way a person says it", () => {
    const work = row({
      id: "work",
      title: "Devon work",
      sourceTitle: "Personal iCloud",
      sourceIdentifier: "personal",
    });
    const plan = interpretCalendarTask({
      task: "please add this to my personal calendar: 8:00–8:45 AM — Breakfast + coffee",
      now,
      timeZone,
      calendars: [devon, work, familyPersonal],
    });
    expect(plan.clarify).toBeUndefined();
    expect(plan.commands[0]).toMatchObject({
      op: "create",
      calendarId: "devon",
      title: "Breakfast + coffee",
      start: "2026-09-26T12:00:00.000Z",
      end: "2026-09-26T12:45:00.000Z",
    });
  });

  it("creates each line of a daily agenda", () => {
    const work = row({
      id: "work",
      title: "Devon work",
      sourceTitle: "Personal iCloud",
      sourceIdentifier: "personal",
      access: "read",
    });
    const agenda = [
      "8:00–8:45 AM — Breakfast + coffee",
      "8:45–9:15 AM — Get situated / light cleanup",
      "9:15 AM–12:30 PM — Alfred deep work block #1",
      "12:30–1:15 PM — Lunch",
      "1:15–2:38 PM — Alfred deep work block #2",
      "2:38–3:23 PM — Workout",
      "3:23–3:50 PM — Cool down, change, quick reset",
      "3:50–4:05 PM — Drive to Target",
      "4:05–4:15 PM — Target pickup / waiting",
      "4:15–4:25 PM — Drive to barber",
      "4:30–5:15 PM — Haircut",
      "5:15–5:30 PM — Head home",
      "5:30–6:00 PM — Shower + reset",
      "6:00–7:00 PM — Stay home for grocery delivery and put groceries away when they arrive",
      "7:00–7:45 PM — Make and eat dinner",
      "7:45–8:00 PM — Quick cleanup",
      "8:00–9:00 PM — Call with Matty",
    ].join("\n");
    const plan = interpretCalendarTask({
      task: agenda,
      now,
      timeZone,
      calendars: [devon, work, { ...familyPersonal, access: "read" }],
    });
    expect(plan.clarify).toBeUndefined();
    expect(plan.commands.map((command) => command.op === "create" && command.title)).toEqual([
      "Breakfast + coffee",
      "Get situated / light cleanup",
      "Alfred deep work block #1",
      "Lunch",
      "Alfred deep work block #2",
      "Workout",
      "Cool down, change, quick reset",
      "Drive to Target",
      "Target pickup / waiting",
      "Drive to barber",
      "Haircut",
      "Head home",
      "Shower + reset",
      "Stay home for grocery delivery and put groceries away when they arrive",
      "Make and eat dinner",
      "Quick cleanup",
      "Call with Matty",
    ]);
    const lunch = plan.commands[3];
    const deepWork = plan.commands[2];
    const call = plan.commands[16];
    expect(lunch).toMatchObject({
      calendarId: "devon",
      start: "2026-09-26T16:30:00.000Z",
      end: "2026-09-26T17:15:00.000Z",
    });
    expect(deepWork).toMatchObject({
      start: "2026-09-26T13:15:00.000Z",
      end: "2026-09-26T16:30:00.000Z",
    });
    expect(call).toMatchObject({
      start: "2026-09-27T00:00:00.000Z",
      end: "2026-09-27T01:00:00.000Z",
    });
  });

  it("puts a dated agenda on that date, not on a weekday named inside an item", () => {
    const agenda = [
      "Sun, Sept 27",
      "8:00–8:45 AM — Breakfast + coffee",
      "9:00–10:00 AM — Monday prep",
    ].join("\n");
    const plan = interpretCalendarTask({
      task: agenda,
      now,
      timeZone,
      calendars: [devon],
    });
    expect(plan.commands.map((command) => command.op === "create" && command.title)).toEqual([
      "Breakfast + coffee",
      "Monday prep",
    ]);
    expect(plan.commands[0]).toMatchObject({
      start: "2026-09-27T12:00:00.000Z",
      end: "2026-09-27T12:45:00.000Z",
    });
    expect(plan.commands[1]).toMatchObject({ start: "2026-09-27T13:00:00.000Z" });
  });

  it("keeps Sept 27 when the day on screen is the following Monday", () => {
    const plan = interpretCalendarTask({
      task: "Sun, Sept 27\n8:00–8:45 AM — Breakfast + coffee\n9:00–10:00 AM — Deep work",
      now: new Date("2026-09-28T16:00:00.000Z"),
      timeZone,
      calendars: [devon],
    });
    expect(plan.commands[0]).toMatchObject({ start: "2026-09-27T12:00:00.000Z" });
  });

  it("does not take the agenda day from a weekday inside an event title", () => {
    const plan = interpretCalendarTask({
      task: "8:00–8:45 AM — Breakfast + coffee\n9:00–10:00 AM — Monday prep",
      now,
      timeZone,
      calendars: [devon],
    });
    expect(plan.commands[0]).toMatchObject({ start: "2026-09-26T12:00:00.000Z" });
  });

  it("keeps a named day when a flattened note is split into lines", () => {
    const flat = "Sun, Sept 27 8:00–8:45 AM — Breakfast + coffee 9:00–10:00 AM — Monday prep";
    expect(agendaDateHeading(flat)).toMatch(/Sept 27/);
    const rewritten = agendaRewrite(
      "Sun, Sept 27\n8:00–8:45 AM — Breakfast + coffee\n9:00–10:00 AM — Monday prep",
    );
    expect(rewritten?.split("\n")[0]).toMatch(/Sept 27/);
    const dropped = agendaRewrite("8:00–8:45 AM — Breakfast + coffee\n9:00–10:00 AM — Monday prep");
    const restored = `${agendaDateHeading(flat)}\n${dropped}`;
    const plan = interpretCalendarTask({
      task: restored,
      now,
      timeZone,
      calendars: [devon],
    });
    expect(plan.commands[0]).toMatchObject({ start: "2026-09-27T12:00:00.000Z" });
    expect(plan.commands[1]).toMatchObject({ title: "Monday prep", start: "2026-09-27T13:00:00.000Z" });
  });

  it("asks which calendar when a pasted agenda does not name one", () => {
    const work = row({
      id: "work",
      title: "Devon work",
      sourceTitle: "Personal iCloud",
      sourceIdentifier: "personal",
    });
    const plan = interpretCalendarTask({
      task: "8:00–8:45 AM — Breakfast + coffee\n9:00–10:00 AM — Deep work",
      now,
      timeZone,
      calendars: [devon, work],
    });
    expect(plan.commands).toEqual([]);
    expect(plan.clarify).toMatch(/Which calendar/);
  });

  it("uses the calendar named beside a pasted agenda", () => {
    const work = row({
      id: "work",
      title: "Devon work",
      sourceTitle: "Personal iCloud",
      sourceIdentifier: "personal",
    });
    const plan = interpretCalendarTask({
      task: "add these to my personal calendar\n8:00–8:45 AM — Breakfast + coffee\n9:00–10:00 AM — Deep work",
      now,
      timeZone,
      calendars: [devon, work],
    });
    expect(plan.commands.map((command) => command.op === "create" && command.calendarId)).toEqual([
      "devon",
      "devon",
    ]);
  });

  it("asks for a model split when a paste lost its line breaks", () => {
    const flat = [
      "8:00–8:45 AM — Breakfast + coffee",
      "8:45–9:15 AM — Get situated / light cleanup",
      "12:30–1:15 PM — Lunch",
    ].join(" ");
    expect(agendaNeedsRewrite(flat, [devon])).toBe(true);
    expect(
      agendaNeedsRewrite(
        ["8:00–8:45 AM — Breakfast + coffee", "8:45–9:15 AM — Get situated / light cleanup", "12:30–1:15 PM — Lunch"].join(
          "\n",
        ),
        [devon],
      ),
    ).toBe(false);
    const rewritten = agendaRewrite(
      "8:00–8:45 AM — Breakfast + coffee\n8:45–9:15 AM — Get situated / light cleanup\n12:30–1:15 PM — Lunch",
    );
    expect(rewritten?.split("\n")).toHaveLength(3);
    expect(agendaRewrite("I can't tell those apart.")).toBeNull();
    const plan = interpretCalendarTask({
      task: rewritten ?? "",
      now,
      timeZone,
      calendars: [devon],
    });
    expect(plan.commands.map((command) => command.op === "create" && command.title)).toEqual([
      "Breakfast + coffee",
      "Get situated / light cleanup",
      "Lunch",
    ]);
  });

  it("uses an earlier request when the follow-up is only the time", () => {
    const plan = interpretCalendarTask({
      task: "8:00 to 8:45 AM",
      context: [
        "user: please add this to my personal calendar: Breakfast + coffee",
        "assistant: What time should I add it? Include AM or PM.",
        "user: 8:00 to 8:45 AM",
      ].join("\n"),
      now,
      timeZone,
      calendars: [devon, familyPersonal],
    });
    expect(plan.commands[0]).toMatchObject({
      op: "create",
      calendarId: "devon",
      title: "Breakfast + coffee",
      start: "2026-09-26T12:00:00.000Z",
      end: "2026-09-26T12:45:00.000Z",
    });
  });
});

describe("runCalendarTask", () => {
  it("answers what's next from the wall clock, not the first event of the day", async () => {
    const standup: CalendarEvent = {
      id: "evt-am",
      title: "Standup",
      start: "2026-09-26T13:00:00.000Z",
      end: "2026-09-26T13:30:00.000Z",
      allDay: false,
      calendarId: "devon",
      calendarTitle: "Devon Personal",
      sourceTitle: "Personal iCloud",
    };
    const dentist: CalendarEvent = {
      id: "evt-pm",
      title: "Dentist",
      start: "2026-09-26T20:00:00.000Z",
      end: "2026-09-26T21:00:00.000Z",
      allDay: false,
      calendarId: "devon",
      calendarTitle: "Devon Personal",
      sourceTitle: "Personal iCloud",
    };
    const gateway: CalendarGateway = {
      async catalog() {
        return [];
      },
      async events() {
        return [standup, dentist];
      },
      async create() {
        throw new Error("no create");
      },
      async update() {
        throw new Error("no update");
      },
      async delete() {
        throw new Error("no delete");
      },
    };
    const speech = await runCalendarTask({
      task: "What's next on my agenda?",
      now,
      timeZone,
      calendars: [devon],
      gateway,
    });
    expect(speech).toMatch(/Next up is Dentist/);
    expect(speech).not.toMatch(/Standup/);
  });

  it("deletes one matching event and leaves two matches untouched", async () => {
    const deleted: string[] = [];
    const dentist: CalendarEvent = {
      id: "evt-1",
      title: "Dentist",
      start: "2026-09-28T15:00:00.000Z",
      end: "2026-09-28T16:00:00.000Z",
      allDay: false,
      calendarId: "devon",
      calendarTitle: "Devon Personal",
      sourceTitle: "Personal iCloud",
    };
    const gateway: CalendarGateway = {
      async catalog() {
        return [];
      },
      async events() {
        return [dentist];
      },
      async create() {
        throw new Error("no create");
      },
      async update() {
        throw new Error("no update");
      },
      async delete(eventId) {
        deleted.push(eventId);
      },
    };
    const speech = await runCalendarTask({
      task: "Delete the dentist appointment",
      now,
      timeZone,
      calendars: [devon],
      gateway,
    });
    expect(deleted).toEqual(["evt-1"]);
    expect(speech).toMatch(/Deleted Dentist/);

    const crowded: CalendarGateway = {
      ...gateway,
      async events() {
        return [dentist, { ...dentist, id: "evt-2", start: "2026-09-29T15:00:00.000Z" }];
      },
      async delete() {
        throw new Error("should not delete");
      },
    };
    const ambiguous = await runCalendarTask({
      task: "Delete the dentist appointment",
      now,
      timeZone,
      calendars: [devon],
      gateway: crowded,
    });
    expect(ambiguous).toMatch(/more than one/);
  });
});
