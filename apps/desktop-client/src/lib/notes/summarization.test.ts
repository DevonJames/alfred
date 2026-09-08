import { describe, expect, it } from "vitest";
import { parseNoteSummary, splitTranscriptForSummary } from "./summarization.js";

describe("parseNoteSummary", () => {
  it("extracts alfred-home metadata from a JSON blob", () => {
    const parsed = parseNoteSummary(`
Here you go:
{
  "summary": "Team agreed to ship Friday.",
  "takeaways": ["Ship pricing"],
  "nextSteps": [{"text": "Write the email", "assignee": "Devon", "dueDate": "2026-09-08"}],
  "openQuestions": ["Does marketing need a heads-up?"],
  "attendees": ["Devon"],
  "template": "meeting"
}
`);
    expect(parsed.summary).toBe("Team agreed to ship Friday.");
    expect(parsed.takeaways).toEqual(["Ship pricing"]);
    expect(parsed.nextSteps[0]).toEqual({
      text: "Write the email",
      assignee: "Devon",
      dueDate: "2026-09-08",
    });
    expect(parsed.openQuestions).toHaveLength(1);
    expect(parsed.template).toBe("meeting");
  });

  it("splits a long rental transcript on paragraph boundaries", () => {
    const parts = splitTranscriptForSummary(`${"Alpha. ".repeat(2000)}\n\n${"Beta. ".repeat(2000)}`, 4000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(" ").includes("Alpha")).toBe(true);
    expect(parts.join(" ").includes("Beta")).toBe(true);
  });
});
