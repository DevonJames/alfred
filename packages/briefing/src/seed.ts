import type { OipLocalMemoryProvider } from "@alfred/memory";
import { getBriefingDayKey } from "./day.js";

/** Create a pending date-only reminder for today's briefing day (testing helper). */
export async function seedDueReminder(
  memory: OipLocalMemoryProvider,
  opts: {
    text: string;
    timezone?: string;
    dayStart?: string;
    now?: Date;
  },
): Promise<{ recordId: string; remindAt: string }> {
  const timezone = opts.timezone ?? "America/Los_Angeles";
  const dayStart = opts.dayStart ?? "04:30";
  const remindAt = getBriefingDayKey(opts.now ?? new Date(), timezone, dayStart);
  const record = await memory.createRecord("Assertion", {
    name: opts.text.slice(0, 80),
    text: opts.text,
    remindAt,
    reminderStatus: "pending",
    reminderReason: "user_requested",
    reminderTimezone: timezone,
    schema: { "@type": "Thing", name: opts.text.slice(0, 80) },
    alfred: { visibility: "private", assertionType: "explicit", confidence: 1 },
    provenance: {
      sourceType: "briefing_seed",
      learnedAt: new Date().toISOString(),
      extractionMethod: "seedDueReminder",
    },
  });
  return { recordId: record.id, remindAt };
}
