import { describe, expect, it } from "vitest";
import {
  agendaWindow,
  answerAgendaClock,
  describeAgendaView,
  looksLikeAgendaQuestion,
} from "./agenda.js";

const timeZone = "America/New_York";
const now = new Date("2026-09-26T18:00:00.000Z");

describe("agendaWindow", () => {
  it("bounds today in the local timezone", () => {
    const window = agendaWindow("today", now, timeZone);
    expect(window.dateLabel).toBe("Saturday, September 26");
    expect(window.start).toBe("2026-09-26T04:00:00.000Z");
    expect(window.end).toBe("2026-09-27T04:00:00.000Z");
  });

  it("bounds the Sunday week that contains today", () => {
    const window = agendaWindow("week", now, timeZone);
    expect(window.rangeLabel).toBe("Sep 20 – Sep 26, 2026");
    expect(window.start).toBe("2026-09-20T04:00:00.000Z");
    expect(window.end).toBe("2026-09-27T04:00:00.000Z");
    expect(window.focusLabel).toBe("Today");
    expect(window.dayOffset).toBe(0);
  });

  it("names yesterday, tomorrow, and further days", () => {
    const yesterday = agendaWindow("today", now, timeZone, new Date("2026-09-25T16:00:00.000Z"));
    expect(yesterday.focusLabel).toBe("Yesterday");
    expect(yesterday.dateLabel).toBe("Friday, September 25");
    expect(yesterday.start).toBe("2026-09-25T04:00:00.000Z");
    expect(yesterday.end).toBe("2026-09-26T04:00:00.000Z");
    expect(yesterday.dayOffset).toBe(-1);

    const tomorrow = agendaWindow("today", now, timeZone, new Date("2026-09-27T16:00:00.000Z"));
    expect(tomorrow.focusLabel).toBe("Tomorrow");
    expect(tomorrow.dateLabel).toBe("Sunday, September 27");

    expect(agendaWindow("today", now, timeZone, new Date("2026-09-28T16:00:00.000Z")).focusLabel).toBe(
      "In 2 days",
    );
    expect(agendaWindow("today", now, timeZone, new Date("2026-09-24T16:00:00.000Z")).focusLabel).toBe(
      "2 days ago",
    );
  });

  it("bounds the Sunday week that contains a later day", () => {
    const window = agendaWindow("week", now, timeZone, new Date("2026-10-03T16:00:00.000Z"));
    expect(window.rangeLabel).toBe("Sep 27 – Oct 3, 2026");
    expect(window.start).toBe("2026-09-27T04:00:00.000Z");
    expect(window.end).toBe("2026-10-04T04:00:00.000Z");
    expect(window.focusDate).toBe("2026-10-03");
    expect(window.todayDate).toBe("2026-09-26");
  });
});

describe("describeAgendaView", () => {
  it("tells the assistant which calendar view is on screen", () => {
    const text = describeAgendaView({
      view: "week",
      timeZone,
      rangeLabel: "Sep 20 – Sep 26, 2026",
      unified: false,
      calendars: [{ title: "Family", sourceTitle: "Personal iCloud" }],
      events: [
        {
          title: "Dentist",
          start: "2026-09-26T15:00:00.000Z",
          end: "2026-09-26T16:00:00.000Z",
          calendarTitle: "Family",
          sourceTitle: "Personal iCloud",
        },
      ],
    });
    expect(text).toMatch(/asking about their calendar/);
    expect(text).toMatch(/Week/);
    expect(text).toMatch(/Sep 20 – Sep 26, 2026/);
    expect(text).toMatch(/Family \(Personal iCloud\)/);
    expect(text).toMatch(/one pane per calendar/);
    expect(text).toMatch(/Dentist/);
    expect(text).toMatch(/11:00 AM–12:00 PM/);
    const withClock = describeAgendaView({
      view: "today",
      timeZone,
      rangeLabel: "Saturday, September 26",
      now,
      unified: true,
      calendars: [],
      events: [],
    });
    expect(withClock).toMatch(/The clock reads 2:00 PM/);
    expect(withClock).toMatch(/Today is Saturday, September 26/);
    expect(withClock).toMatch(/how long until an event/);
  });

  it("describes the unified layout", () => {
    const text = describeAgendaView({
      view: "today",
      timeZone,
      rangeLabel: "Saturday, September 26",
      unified: true,
      calendars: [],
      events: [],
    });
    expect(text).toMatch(/unified calendar/);
    expect(text).toMatch(/No Access/);
  });
});

describe("answerAgendaClock", () => {
  const events = [
    {
      title: "USPTO",
      start: "2026-09-29T12:45:00.000Z",
      end: "2026-09-29T15:30:00.000Z",
      calendarTitle: "Devon work",
      sourceTitle: "Personal iCloud",
    },
    {
      title: "USPTO",
      start: "2026-09-29T16:00:00.000Z",
      end: "2026-09-29T22:15:00.000Z",
      calendarTitle: "Devon work",
      sourceTitle: "Personal iCloud",
    },
    {
      title: "USPTO",
      start: "2026-09-30T16:30:00.000Z",
      end: "2026-09-30T21:00:00.000Z",
      calendarTitle: "Devon work",
      sourceTitle: "Personal iCloud",
    },
    {
      title: "Lunch",
      start: "2026-09-29T16:30:00.000Z",
      end: "2026-09-29T17:00:00.000Z",
      calendarTitle: "Devon Personal",
      sourceTitle: "Personal iCloud",
    },
  ];

  it("uses the in-progress work block on today's date", () => {
    const answer = answerAgendaClock({
      text: "How much longer am I at work?",
      now: new Date("2026-09-29T19:19:00.000Z"),
      timeZone,
      events,
    });
    expect(answer).toBe("You have 2 hours and 56 minutes left at work, in USPTO, until 6:15 PM.");
  });

  it("does not answer a question that is not about the clock", () => {
    expect(answerAgendaClock({
      text: "Can I squeeze in a call?",
      now: new Date("2026-09-29T19:19:00.000Z"),
      timeZone,
      events,
    })).toBeNull();
  });

  it("says when the named event starts if it has not begun", () => {
    const answer = answerAgendaClock({
      text: "How long until lunch?",
      now: new Date("2026-09-29T15:00:00.000Z"),
      timeZone,
      events,
    });
    expect(answer).toBe("Lunch starts at 12:30 PM, in 1 hour and 30 minutes.");
  });
});

describe("looksLikeAgendaQuestion", () => {
  it("matches calendar rundown asks", () => {
    expect(looksLikeAgendaQuestion("What's on my agenda today?")).toBe(true);
    expect(looksLikeAgendaQuestion("What does my schedule look like?")).toBe(true);
    expect(looksLikeAgendaQuestion("Any meetings today?")).toBe(true);
    expect(looksLikeAgendaQuestion("Am I free this afternoon?")).toBe(true);
    expect(looksLikeAgendaQuestion("What's on for tomorrow?")).toBe(true);
  });

  it("leaves the daily briefing alone", () => {
    expect(looksLikeAgendaQuestion("Give me the daily briefing")).toBe(false);
    expect(looksLikeAgendaQuestion("Please give me today's daily briefing.")).toBe(false);
    expect(looksLikeAgendaQuestion("What's on my plate?")).toBe(false);
  });
});
