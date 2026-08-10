import { createBriefingController } from "@alfred/briefing";
import {
  defaultOipMemoryRoot,
  OipLocalMemoryProvider,
} from "@alfred/memory";
import { Hono } from "hono";

function oipForProfile(): OipLocalMemoryProvider {
  const profileId = process.env.ALFRED_PROFILE_ID ?? "profile.default";
  return new OipLocalMemoryProvider(defaultOipMemoryRoot(profileId));
}

export const briefingRouter = new Hono();

/** GET /api/briefing?refresh=1 */
briefingRouter.get("/briefing", async (c) => {
  const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
  const memory = oipForProfile();
  const controller = createBriefingController({ memory });
  try {
    const payload = await controller.generate({ refresh, markSurfaced: false });
    return c.json(payload);
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

/** GET /api/memory/due?date=&timezone= */
briefingRouter.get("/memory/due", async (c) => {
  const memory = oipForProfile();
  const date = c.req.query("date") ?? undefined;
  const timezone =
    c.req.query("timezone") ?? process.env.BRIEFING_TIMEZONE ?? "America/Los_Angeles";
  try {
    const due = await memory.listDue({ date, timezone });
    return c.json({
      date: date ?? null,
      timezone,
      count: due.length,
      reminders: due.map((r) => ({
        recordId: r.recordId,
        logicalId: r.logicalId,
        name: r.recordName,
        text: r.revision.text ?? null,
        remindAt: r.remindAt,
        reminderStatus: r.reminderStatus,
        reminderReason: r.reminderReason,
        reminderTimezone: r.reminderTimezone,
        reminderSnoozedUntil: r.reminderSnoozedUntil,
      })),
    });
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});
