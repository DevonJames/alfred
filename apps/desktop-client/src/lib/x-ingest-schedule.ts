import { composeNotesCaptureAdapter, ingestXNotes } from "@alfred/memory";
import { createPlaywrightCaptureAdapter } from "@alfred/browser";
import { localDateTimeParts } from "@alfred/briefing";

function parseHm(raw: string): { hour: number; minute: number } {
  const [h, m] = raw.split(":").map(Number);
  return { hour: h ?? 6, minute: m ?? 0 };
}

/**
 * Run registered X-note ingest once per local calendar day at ALFRED_X_INGEST_SCHEDULE (default 06:00).
 */
export function startXIngestScheduler(): () => void {
  const timezone = process.env.BRIEFING_TIMEZONE ?? "America/Los_Angeles";
  const schedule = process.env.ALFRED_X_INGEST_SCHEDULE ?? "06:00";
  const { hour: targetH, minute: targetM } = parseHm(schedule);
  let lastDay = "";
  const tick = async () => {
    const now = new Date();
    const local = localDateTimeParts(now, timezone);
    const day = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
    if (local.hour !== targetH || local.minute !== targetM) return;
    if (lastDay === day) return;
    lastDay = day;
    const profileId = process.env.ALFRED_PROFILE_ID ?? "profile.default";
    console.log(`[x-ingest] starting scheduled ingest for ${day}`);
    try {
      const capture = composeNotesCaptureAdapter(createPlaywrightCaptureAdapter());
      const result = await ingestXNotes({ profileId, capture });
      console.log(
        `[x-ingest] done: ${result.processed.filter((p) => p.status === "ingested").length} saved, ${result.processed.filter((p) => p.status === "failed").length} failed`,
      );
    } catch (err) {
      console.error("[x-ingest] scheduled run failed:", err);
    }
  };
  const id = setInterval(() => void tick(), 30_000);
  void tick();
  return () => clearInterval(id);
}
