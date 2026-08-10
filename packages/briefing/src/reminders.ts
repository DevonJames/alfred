import type { DueReminder, OipLocalMemoryProvider } from "@alfred/memory";

export async function loadDueReminders(
  memory: OipLocalMemoryProvider | null | undefined,
  opts: { date: string; timezone: string; windowEnd?: string },
): Promise<DueReminder[]> {
  if (!memory) return [];
  try {
    return await memory.listDue({
      date: opts.date,
      timezone: opts.timezone,
      windowEnd: opts.windowEnd,
    });
  } catch {
    return [];
  }
}

export function formatRemindersSpeech(reminders: DueReminder[]): string {
  if (!reminders.length) return "";
  const lines = reminders.slice(0, 8).map((r) => {
    const summary =
      r.revision.text?.trim() ||
      r.recordName ||
      r.revision.name ||
      "a reminder";
    return summary.replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
  });
  if (lines.length === 1) {
    return `You asked me to remind you: ${lines[0]}.`;
  }
  return `You have ${lines.length} reminders: ${lines.join("; ")}.`;
}

export function formatRemindersMarkdown(reminders: DueReminder[]): string {
  if (!reminders.length) return "";
  const body = reminders
    .slice(0, 12)
    .map((r) => {
      const summary =
        r.revision.text?.trim() || r.recordName || r.revision.name || "Reminder";
      const when = r.remindAt ? ` (${r.remindAt})` : "";
      return `- ${summary}${when}`;
    })
    .join("\n");
  return `**Reminders**\n\n${body}`;
}

export async function markRemindersSurfaced(
  memory: OipLocalMemoryProvider | null | undefined,
  reminders: DueReminder[],
): Promise<void> {
  if (!memory) return;
  for (const r of reminders) {
    try {
      await memory.markReminderSurfaced(r.recordId);
    } catch {
      // continue
    }
  }
}
