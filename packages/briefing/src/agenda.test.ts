import { describe, expect, it } from "vitest";
import { formatAgendaSpeech } from "./agenda.js";

describe("formatAgendaSpeech", () => {
  it("speaks the event that is on today's date", () => {
    const speech = formatAgendaSpeech(
      [
        {
          title: "USPTO",
          start: "2026-10-07T16:00:00.000Z",
          end: "2026-10-07T22:15:00.000Z",
          calendarTitle: "Devon work",
        },
      ],
      "America/New_York",
    );
    expect(speech).toBe("On your agenda today: USPTO from noon to 6 15 pm.");
  });
});
