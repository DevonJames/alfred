import { describe, expect, it } from "vitest";
import { resolveReminderMatch } from "./reminder-match.js";
import type { DueReminderSummary } from "./ports.js";

const due: DueReminderSummary[] = [
  {
    recordId: "did:memory:hr1",
    summary: "Check with HR about the formal offer letter",
    remindAt: "2026-08-10",
    status: "surfaced",
  },
  {
    recordId: "did:memory:wine1",
    summary: "Pick up wine for dinner",
    remindAt: "2026-08-18",
    status: "pending",
  },
];

describe("resolveReminderMatch", () => {
  it("resolves by recordId", () => {
    const r = resolveReminderMatch(due, { recordId: "did:memory:hr1" });
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.reminder.summary).toContain("HR");
  });

  it("resolves a unique text match", () => {
    const r = resolveReminderMatch(due, { match: "offer letter" });
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.reminder.recordId).toBe("did:memory:hr1");
  });

  it("returns none when nothing matches", () => {
    const r = resolveReminderMatch(due, { match: "passport renewal" });
    expect(r.kind).toBe("none");
  });

  it("returns ambiguous when two reminders score closely", () => {
    const close: DueReminderSummary[] = [
      {
        recordId: "a",
        summary: "Call the dentist about cleaning",
        remindAt: null,
        status: "pending",
      },
      {
        recordId: "b",
        summary: "Call the doctor about cleaning",
        remindAt: null,
        status: "pending",
      },
    ];
    const r = resolveReminderMatch(close, { match: "call about cleaning" });
    expect(r.kind).toBe("ambiguous");
  });

  it("picks the only due reminder when match is empty", () => {
    const r = resolveReminderMatch([due[0]!], { match: "" });
    expect(r.kind).toBe("exact");
    if (r.kind === "exact") expect(r.reminder.recordId).toBe("did:memory:hr1");
  });
});
