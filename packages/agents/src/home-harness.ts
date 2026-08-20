import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentHarness,
  AgentHarnessManifest,
  TaskCategory,
} from "@alfred/contracts";

export interface AlfredHomeHarnessOptions {
  baseUrl?: string;
  secret?: string;
  getContext?: () => {
    householdId?: string;
    deviceToken?: string;
  };
}

const HOME_CATEGORIES: TaskCategory[] = ["household", "calendar", "general"];

/**
 * Delegates household tools (calendar, camera, approvals, reminders) to alfred-home.
 */
export class AlfredHomeHarness implements AgentHarness {
  readonly manifest: AgentHarnessManifest = {
    id: "harness.alfred-home",
    displayName: "Alfred:Home household tools",
    version: "0.1.0",
    capabilities: ["household", "calendar", "general", "computer_use"],
    notes: "HTTP callback into alfred-home /internal/conversation-tools",
  };

  constructor(private readonly opts: AlfredHomeHarnessOptions = {}) {}

  supports(category: TaskCategory): boolean {
    return HOME_CATEGORIES.includes(category) || category === "computer_use";
  }

  async execute(request: AgentDelegationRequest): Promise<AgentDelegationResult> {
    const baseUrl = (this.opts.baseUrl ?? process.env.ALFRED_HOME_INTERNAL_URL ?? "http://127.0.0.1:3000").replace(
      /\/$/,
      "",
    );
    const secret =
      this.opts.secret ??
      process.env.ALFRED_HOME_INTERNAL_SECRET ??
      process.env.ALFRED_CORE_SECRET ??
      "";
    if (!secret) {
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: "",
        error: "ALFRED_CORE_SECRET / ALFRED_HOME_INTERNAL_SECRET is not configured",
        metadata: {},
      };
    }

    const ctx = this.opts.getContext?.() ?? {};
    try {
      const res = await fetch(`${baseUrl}/internal/conversation-tools/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": secret,
        },
        body: JSON.stringify({
          householdId: ctx.householdId,
          deviceToken: ctx.deviceToken,
          category: request.taskCategory,
          taskDescription: request.taskDescription,
          conversationContext: request.conversationContext,
          correlationId: request.correlationId,
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        output?: string;
        error?: string;
        ok?: boolean;
      };
      if (!res.ok) {
        return {
          correlationId: request.correlationId,
          harnessId: this.manifest.id,
          status: "failed",
          output: "",
          error: payload.error ?? `alfred-home tools HTTP ${res.status}`,
          metadata: { status: res.status },
        };
      }
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "completed",
        output: payload.output ?? JSON.stringify(payload),
        metadata: { ok: payload.ok ?? true },
      };
    } catch (err) {
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: "",
        error: err instanceof Error ? err.message : String(err),
        metadata: {},
      };
    }
  }
}

export function createAlfredHomeHarness(opts?: AlfredHomeHarnessOptions): AlfredHomeHarness {
  return new AlfredHomeHarness(opts);
}
