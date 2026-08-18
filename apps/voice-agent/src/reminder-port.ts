import type { DueReminderSummary, ReminderPort, ReminderStatusAction } from "@alfred/core";
import type { BriefingController } from "@alfred/briefing";
import type { OipLocalMemoryProvider } from "@alfred/memory";

/**
 * Voice-side ReminderPort over OIP due reminders + briefing cache invalidation.
 */
export function createOipReminderPort(
  memory: OipLocalMemoryProvider,
  briefing: BriefingController,
): ReminderPort {
  return {
    async listDue(opts) {
      const due = await memory.listDue({
        now: opts?.now,
        timezone: briefing.config.timezone,
      });
      return due.map(
        (r): DueReminderSummary => ({
          recordId: r.recordId,
          summary:
            r.revision.text?.trim() ||
            r.recordName ||
            r.revision.name ||
            "Reminder",
          remindAt: r.remindAt,
          status: r.reminderStatus,
        }),
      );
    },

    async setStatus(recordId, status, snoozedUntil) {
      const patch: {
        reminderStatus: ReminderStatusAction;
        reminderSnoozedUntil?: string | null;
        reminderCompletedAt?: string;
      } = { reminderStatus: status };

      if (status === "snoozed") {
        if (!snoozedUntil) {
          throw new Error("snoozedUntil is required when status=snoozed");
        }
        patch.reminderSnoozedUntil = snoozedUntil;
      } else if (status === "completed" || status === "dismissed") {
        patch.reminderSnoozedUntil = null;
        patch.reminderCompletedAt = new Date().toISOString();
      } else {
        patch.reminderSnoozedUntil = null;
      }

      await memory.updateRecord(recordId, patch);
    },

    async invalidateBriefingDay(now) {
      await briefing.invalidateTodayCache(now);
    },
  };
}
