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
    return `Saved ${item.headline ?? "that X post"} to memory${from}.`;
  }
  if (item.status === "failed") {
    const title = item.headline ?? item.url;
    return `The link titled ${title} could not be ingested because of ${item.error ?? "an error"}.`;
  }
  return `Skipped ${item.url}.`;
}

export function speechFromRun(run: XIngestRunResult): string {
  const ok = run.processed.filter((p) => p.status === "ingested");
  const failed = run.processed.filter((p) => p.status === "failed");
  if (!run.processed.length) return "There were no new X links in your notes.";
  const parts: string[] = [];
  if (ok.length === 1) parts.push(speechFromItem(ok[0]!));
  else if (ok.length > 1) {
    parts.push(`Saved ${ok.length} X items: ${ok.map((i) => i.headline ?? i.url).join("; ")}.`);
  }
  for (const f of failed) parts.push(speechFromItem(f));
  return parts.join(" ") || "X ingest finished.";
}

export class XIngestHarness implements AgentHarness {
  readonly manifest: AgentHarnessManifest = {
    id: "harness.x-ingest",
    displayName: "X Notes Ingest",
    version: "0.1.0",
    capabilities: ["research", "browser", "computer_use"],
    notes: "Ingests X.com links from Apple Notes or a single URL via local browser capture.",
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
      !/\b(x\.com|twitter|ingest.{0,20}(x|note)|x notes)\b/i.test(request.taskDescription)
    ) {
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: "",
        error: "Not an X ingest task",
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
