import { describe, expect, it } from "vitest";
import {
  agendaWindow,
  answerAgendaClock,
  answerNextAgendaItem,
  describeAgendaView,
  looksLikeAgendaQuestion,
  looksLikeNextAgendaQuestion,
  hoursWeekShift,
  looksLikeHoursQuestion,
  parseHoursPick,
  pickNextAgendaEvent,
  sumMatchedHours,
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
    expect(withClock).toMatch(/next upcoming timed event after the clock/);
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
    expect(looksLikeAgendaQuestion("What's next on my agenda?")).toBe(true);
  });

  it("leaves the daily briefing alone", () => {
    expect(looksLikeAgendaQuestion("Give me the daily briefing")).toBe(false);
    expect(looksLikeAgendaQuestion("Please give me today's daily briefing.")).toBe(false);
    expect(looksLikeAgendaQuestion("What's on my plate?")).toBe(false);
  });
});

describe("answerNextAgendaItem", () => {
  const day = [
    {
      title: "Standup",
      start: "2026-09-26T13:00:00.000Z",
      end: "2026-09-26T13:30:00.000Z",
      calendarTitle: "Work",
      sourceTitle: "iCloud",
    },
    {
      title: "Dentist",
      start: "2026-09-26T20:00:00.000Z",
      end: "2026-09-26T21:00:00.000Z",
      calendarTitle: "Personal",
      sourceTitle: "iCloud",
    },
    {
      title: "Morning run",
      start: "2026-09-27T12:00:00.000Z",
      end: "2026-09-27T12:45:00.000Z",
      calendarTitle: "Personal",
      sourceTitle: "iCloud",
    },
  ];

  it("matches next-item phrasing", () => {
    expect(looksLikeNextAgendaQuestion("What's next on my agenda?")).toBe(true);
    expect(looksLikeNextAgendaQuestion("What is coming up next?")).toBe(true);
    expect(looksLikeNextAgendaQuestion("What's my next meeting?")).toBe(true);
    expect(looksLikeNextAgendaQuestion("What's on my agenda today?")).toBe(false);
  });

  it("skips past events and names the next timed item from the wall clock", () => {
    // 10:00 PM Eastern on Sep 26 — standup and dentist are over; morning run is tomorrow.
    const late = new Date("2026-09-27T02:00:00.000Z");
    expect(pickNextAgendaEvent(day, late)?.title).toBe("Morning run");
    const answer = answerNextAgendaItem({
      text: "What's next on my agenda?",
      now: late,
      timeZone,
      events: day,
    });
    expect(answer).toMatch(/Next up is Morning run/);
    expect(answer).toMatch(/Tomorrow/);
    expect(answer).not.toMatch(/Standup/);
  });

  it("names an upcoming item later the same day", () => {
    // 2:00 PM Eastern — standup done, dentist still ahead.
    const answer = answerNextAgendaItem({
      text: "What's next on my agenda?",
      now,
      timeZone,
      events: day,
    });
    expect(answer).toBe("Next up is Dentist at 4:00 PM, in 2 hours.");
  });

  it("says nothing is left when the list is exhausted", () => {
    const answer = answerNextAgendaItem({
      text: "What's next?",
      now: new Date("2026-09-28T02:00:00.000Z"),
      timeZone,
      events: day,
    });
    expect(answer).toBe("Nothing left on your agenda from now.");
  });
});

describe("sumMatchedHours", () => {
  const work = (id: string, title: string, start: string, end: string) => ({
    id,
    title,
    start,
    end,
    calendarTitle: "Devon work",
    sourceTitle: "Personal iCloud",
  });

  it("adds only the events the model selected, and counts an overlap once", () => {
    expect(looksLikeHoursQuestion("count my total work hours this week please")).toBe(true);
    expect(looksLikeHoursQuestion("how much longer am I at work")).toBe(false);
    expect(looksLikeHoursQuestion("break it into hours per day please")).toBe(true);
    expect(hoursWeekShift("how many hours of work am I working next week")).toBe(7);
    expect(hoursWeekShift("break it into hours per day", "User: how many hours next week")).toBe(7);
    expect(hoursWeekShift("how many hours this week", "User: how many hours next week")).toBe(0);
    expect(parseHoursPick('{"label":"work","ids":["mon","meeting"]}')).toEqual({
      label: "work",
      ids: ["mon", "meeting"],
    });
    const events = [
      work("mon", "USPTO", "2026-10-19T13:00:00.000Z", "2026-10-19T22:45:00.000Z"),
      work("meeting", "Meeting", "2026-10-19T21:00:00.000Z", "2026-10-19T22:00:00.000Z"),
      work("tue", "USPTO", "2026-10-20T12:00:00.000Z", "2026-10-20T22:45:00.000Z"),
      work("wed", "USPTO", "2026-10-21T13:00:00.000Z", "2026-10-21T21:00:00.000Z"),
      work("thu", "USPTO", "2026-10-22T13:00:00.000Z", "2026-10-22T22:00:00.000Z"),
      work("fri", "USPTO", "2026-10-23T13:00:00.000Z", "2026-10-23T22:00:00.000Z"),
      work("sat", "USPTO", "2026-10-24T13:00:00.000Z", "2026-10-24T22:30:00.000Z"),
      {
        id: "story",
        title: "Library Storytime",
        start: "2026-10-19T17:00:00.000Z",
        end: "2026-10-19T17:30:00.000Z",
        calendarTitle: "Family",
        sourceTitle: "Family iCloud",
      },
    ];
    const answer = sumMatchedHours({
      timeZone,
      label: "work",
      period: "this week",
      events,
      ids: ["mon", "meeting", "tue", "wed", "thu", "fri", "sat"],
    });
    expect(answer).toBe(
      [
        "You have 56 hours of work scheduled this week.",
        "Monday: 9 hours and 45 minutes",
        "Tuesday: 10 hours and 45 minutes",
        "Wednesday: 8 hours",
        "Thursday: 9 hours",
        "Friday: 9 hours",
        "Saturday: 9 hours and 30 minutes",
      ].join("\n"),
    );
  });

  it("uses an all-day note's stated hours when that is what was selected", () => {
    const answer = sumMatchedHours({
      timeZone,
      label: "work",
      period: "next week",
      events: [
        {
          id: "banner",
          title: "12-hour days @ uspto",
          start: "2026-10-26T04:00:00.000Z",
          end: "2026-10-28T03:59:00.000Z",
          allDay: true,
          calendarTitle: "Devon Personal",
          sourceTitle: "Personal iCloud",
        },
      ],
      ids: ["banner"],
    });
    expect(answer).toBe(
      ["You have 24 hours of work scheduled next week.", "Monday: 12 hours", "Tuesday: 12 hours"].join("\n"),
    );
  });
});
