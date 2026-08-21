import { composeNotesCaptureAdapter, ingestDocsFolders, ingestXNotes } from "@alfred/memory";
import { createPlaywrightCaptureAdapter } from "@alfred/browser";
import { localDateTimeParts } from "@alfred/briefing";

function parseHm(raw: string): { hour: number; minute: number } {
  const [h, m] = raw.split(":").map(Number);
  return { hour: h ?? 6, minute: m ?? 0 };
}

/**
 * Run registered X-note and docs-folder ingest once per local calendar day
 * (default 06:00; docs may override with ALFRED_DOCS_INGEST_SCHEDULE).
 */
export function startXIngestScheduler(): () => void {
  const timezone = process.env.BRIEFING_TIMEZONE ?? "America/Los_Angeles";
  const schedule = process.env.ALFRED_X_INGEST_SCHEDULE ?? "06:00";
  const docsSchedule = process.env.ALFRED_DOCS_INGEST_SCHEDULE ?? schedule;
  const xHm = parseHm(schedule);
  const docsHm = parseHm(docsSchedule);
  let lastXDay = "";
  let lastDocsDay = "";
  const tick = async () => {
    const now = new Date();
    const local = localDateTimeParts(now, timezone);
    const day = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
    const profileId = process.env.ALFRED_PROFILE_ID ?? "profile.default";
    if (local.hour === xHm.hour && local.minute === xHm.minute && lastXDay !== day) {
      lastXDay = day;
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
    }
    if (local.hour === docsHm.hour && local.minute === docsHm.minute && lastDocsDay !== day) {
      lastDocsDay = day;
      console.log(`[docs-ingest] starting scheduled ingest for ${day}`);
      try {
        const result = await ingestDocsFolders({ profileId });
        console.log(
          `[docs-ingest] done: ${result.processed.filter((p) => p.status === "ingested").length} saved, ${result.processed.filter((p) => p.status === "skipped").length} skipped, ${result.processed.filter((p) => p.status === "failed").length} failed`,
        );
      } catch (err) {
        console.error("[docs-ingest] scheduled run failed:", err);
      }
    }
  };
  const id = setInterval(() => void tick(), 30_000);
  void tick();
  return () => clearInterval(id);
}
