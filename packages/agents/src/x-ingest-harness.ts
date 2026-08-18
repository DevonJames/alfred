import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentHarness,
  AgentHarnessManifest,
  TaskCategory,
} from "@alfred/contracts";
import {
  ingestXNotes,
  ingestXUrl,
  parseXIngestIntent,
  type XCaptureAdapter,
  type XIngestItemResult,
  type XIngestRunResult,
} from "@alfred/memory";

export function speechFromItem(item: XIngestItemResult): string {
  if (item.status === "ingested") {
    const from = item.noteName ? ` from your ${item.noteName} note` : "";
    const noun = item.kind === "video" ? "that YouTube video" : "that X post";
    return `Saved ${item.headline ?? noun} to memory${from}.`;
  }
  if (item.status === "failed") {
    const title = item.headline ?? item.url;
    const noun = item.kind === "video" || /youtube|youtu\.be/i.test(item.url) ? "YouTube video" : "link";
    return `The ${noun} titled ${title} could not be ingested because of ${item.error ?? "an error"}.`;
  }
  return `Skipped ${item.url}.`;
}

export function speechFromRun(run: XIngestRunResult): string {
  const ok = run.processed.filter((p) => p.status === "ingested");
  const failed = run.processed.filter((p) => p.status === "failed");
  if (!run.processed.length) return "There were no new X or YouTube links in your notes.";
  const parts: string[] = [];
  if (ok.length === 1) parts.push(speechFromItem(ok[0]!));
  else if (ok.length > 1) {
    parts.push(`Saved ${ok.length} items: ${ok.map((i) => i.headline ?? i.url).join("; ")}.`);
  }
  for (const f of failed) parts.push(speechFromItem(f));
  return parts.join(" ") || "Ingest finished.";
}

export class XIngestHarness implements AgentHarness {
  readonly manifest: AgentHarnessManifest = {
    id: "harness.x-ingest",
    displayName: "X Notes Ingest",
    version: "0.1.0",
    capabilities: ["research", "browser", "computer_use"],
    notes: "Ingests X.com and YouTube links from Apple Notes (Playwright + yt-dlp).",
  };

  constructor(
    private readonly opts: {
      profileId?: string;
      capture: XCaptureAdapter;
    },
  ) {}

  supports(category: TaskCategory): boolean {
    return this.manifest.capabilities.includes(category as never);
  }

  async execute(request: AgentDelegationRequest): Promise<AgentDelegationResult> {
    const profileId = this.opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
    const intent = parseXIngestIntent(request.taskDescription);
    if (
      !intent &&
      !/\b(x\.com|twitter|youtube|youtu\.be|ingest.{0,20}(x|note|youtube)|x notes)\b/i.test(
        request.taskDescription,
      )
    ) {
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: "",
        error: "Not an X or YouTube ingest task",
        metadata: {},
      };
    }
    try {
      if (intent?.kind === "url") {
        const item = await ingestXUrl({
          url: intent.url,
          profileId,
          capture: this.opts.capture,
        });
        return {
          correlationId: request.correlationId,
          harnessId: this.manifest.id,
          status: item.status === "failed" ? "failed" : "completed",
          output: speechFromItem(item),
          error: item.error,
          metadata: { item },
        };
      }

      const run = await ingestXNotes({
        profileId,
        note: intent?.kind === "notes" ? intent.note : undefined,
        capture: this.opts.capture,
      });
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "completed",
        output: speechFromRun(run),
        metadata: { run },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: "",
        error: message,
        metadata: {},
      };
    }
  }
}

export function createXIngestHarness(opts: {
  profileId?: string;
  capture: XCaptureAdapter;
}): XIngestHarness {
  return new XIngestHarness(opts);
}
