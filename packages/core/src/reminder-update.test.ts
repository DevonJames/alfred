import { describe, expect, it, vi } from "vitest";
import type { DueReminderSummary, ReminderPort } from "./ports.js";
import { resolveReminderMatch } from "./reminder-match.js";

/**
 * Mirrors VoiceSessionController.applyReminderUpdate speech preference:
 * side effect runs; model text wins when present.
 */
async function applyReminderUpdateForTest(
  reminders: ReminderPort,
  args: Record<string, unknown>,
  dueReminders: DueReminderSummary[],
  modelText: string,
): Promise<{ spoken: string; statusCalls: number }> {
  const actionRaw = String(args.action ?? "")
    .trim()
    .toLowerCase();
  if (actionRaw !== "completed" && actionRaw !== "dismissed" && actionRaw !== "snoozed") {
    return { spoken: "bad action", statusCalls: 0 };
  }
  const resolved = resolveReminderMatch(dueReminders, {
    recordId: typeof args.recordId === "string" ? args.recordId : null,
    match: typeof args.match === "string" ? args.match : null,
  });
  if (resolved.kind !== "exact") {
    return { spoken: "no match", statusCalls: 0 };
  }
  await reminders.setStatus(
    resolved.reminder.recordId,
    actionRaw,
    typeof args.snoozedUntil === "string" ? args.snoozedUntil : undefined,
  );
  await reminders.invalidateBriefingDay();
  const fallback = `Got it — I've cleared the reminder about ${resolved.reminder.summary}.`;
  return { spoken: modelText.trim() || fallback, statusCalls: 1 };
}

describe("update_reminder speech preference", () => {
  it("calls setStatus and prefers model text", async () => {
    const setStatus = vi.fn(async () => undefined);
    const invalidateBriefingDay = vi.fn(async () => undefined);
    const port: ReminderPort = {
      listDue: async () => [],
      setStatus,
      invalidateBriefingDay,
    };
    const due: DueReminderSummary[] = [
      {
        recordId: "did:memory:hr1",
        summary: "Check with HR about the formal offer letter",
        remindAt: "2026-08-10",
        status: "surfaced",
      },
    ];
    const result = await applyReminderUpdateForTest(
      port,
      { action: "completed", match: "offer letter" },
      due,
      "You're welcome — glad that's sorted.",
    );
    expect(setStatus).toHaveBeenCalledWith("did:memory:hr1", "completed", undefined);
    expect(invalidateBriefingDay).toHaveBeenCalled();
    expect(result.spoken).toBe("You're welcome — glad that's sorted.");
  });

  it("falls back to canned ack when model text is empty", async () => {
    const port: ReminderPort = {
      listDue: async () => [],
      setStatus: async () => undefined,
      invalidateBriefingDay: async () => undefined,
    };
    const due: DueReminderSummary[] = [
      {
        recordId: "did:memory:hr1",
        summary: "Check with HR about the formal offer letter",
        remindAt: "2026-08-10",
        status: "surfaced",
      },
    ];
    const result = await applyReminderUpdateForTest(
      port,
      { action: "completed", match: "HR" },
      due,
      "   ",
    );
    expect(result.spoken).toContain("cleared the reminder");
    expect(result.spoken).toContain("HR");
  });
});
