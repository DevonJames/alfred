import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentHarness,
  AgentHarnessManifest,
  TaskCategory,
} from "@alfred/contracts";
import {
  addDocsSource,
  ingestDocsFolders,
  loadDocsSources,
  parseDocsIngestIntent,
  speechFromDocsRun,
} from "@alfred/memory";

export class DocsIngestHarness implements AgentHarness {
  readonly manifest: AgentHarnessManifest = {
    id: "harness.docs-ingest",
    displayName: "Docs Folder Ingest",
    version: "0.1.0",
    capabilities: ["research"],
    notes: "Ingests local markdown documentation folders into OIP memory.",
  };

  constructor(private readonly opts: { profileId?: string } = {}) {}

  supports(category: TaskCategory): boolean {
    return this.manifest.capabilities.includes(category as never);
  }

  async execute(request: AgentDelegationRequest): Promise<AgentDelegationResult> {
    const profileId = this.opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
    const sources = await loadDocsSources(profileId);
    const intent = parseDocsIngestIntent(
      request.taskDescription,
      sources.map((s) => s.label),
    );
    if (!intent) {
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: "",
        error: "Not a documentation folder ingest task",
        metadata: {},
      };
    }
    try {
      if (intent.kind === "list") {
        const labels = sources.length
          ? sources.map((s) => `${s.label} at ${s.path}`).join("; ")
          : "none registered";
        return {
          correlationId: request.correlationId,
          harnessId: this.manifest.id,
          status: "completed",
          output: `Documentation folders: ${labels}.`,
          metadata: { sources },
        };
      }
      if (intent.kind === "add") {
        const added = await addDocsSource(profileId, { path: intent.path, label: intent.label });
        const run = await ingestDocsFolders({ profileId, path: added.path });
        return {
          correlationId: request.correlationId,
          harnessId: this.manifest.id,
          status: "completed",
          output: `Watching ${added.label}. ${speechFromDocsRun(run)}`,
          metadata: { source: added, run },
        };
      }
      const run = await ingestDocsFolders({
        profileId,
        source: intent.source,
      });
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "completed",
        output: speechFromDocsRun(run),
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

export function createDocsIngestHarness(opts: { profileId?: string } = {}): DocsIngestHarness {
  return new DocsIngestHarness(opts);
}
