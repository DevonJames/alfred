import type { AppleReminder } from "./helper.js";

export interface DatedReminder extends AppleReminder {
  /** YYYY-MM-DD in the briefing timezone, when the reminder has a due date. */
  dueDate: string | null;
  overdue: boolean;
  dueToday: boolean;
}

export function dateKeyInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function dueDateKey(due: string | null | undefined, timeZone: string): string | null {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const parsed = new Date(due);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateKeyInZone(parsed, timeZone);
}

/** Open reminders whose due date is today or earlier. Undated items stay off the morning brief. */
export function remindersForBriefing(
  reminders: AppleReminder[],
  now: Date,
  timeZone: string,
): DatedReminder[] {
  const today = dateKeyInZone(now, timeZone);
  return reminders
    .filter((reminder) => !reminder.completed)
    .map((reminder) => {
      const dueDate = dueDateKey(reminder.due, timeZone);
      return {
        ...reminder,
        dueDate,
        overdue: Boolean(dueDate && dueDate < today),
        dueToday: dueDate === today,
      };
    })
    .filter((reminder) => reminder.dueToday || reminder.overdue);
}
