import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentHarness,
  AgentHarnessManifest,
  TaskCategory,
} from "@alfred/contracts";

export interface OpenClawHarnessOptions {
  baseUrl?: string;
  token?: string;
  agentId?: string;
}

const OPENCLAW_CATEGORIES: TaskCategory[] = [
  "coding",
  "email",
  "browser",
  "computer_use",
  "research",
  "general",
];

/**
 * Real OpenClaw harness for coding/email-style work. Uses the gateway chat
 * completions API with an optional first-class agent header — not the
 * household conversation path.
 */
export class OpenClawHarness implements AgentHarness {
  readonly manifest: AgentHarnessManifest = {
    id: "harness.openclaw",
    displayName: "OpenClaw",
    version: "0.1.0",
    capabilities: ["email", "coding", "browser", "computer_use", "research", "general"],
    notes: "OpenClaw gateway /v1/chat/completions for delegated agent tasks",
  };

  constructor(private readonly opts: OpenClawHarnessOptions = {}) {}

  supports(category: TaskCategory): boolean {
    return OPENCLAW_CATEGORIES.includes(category);
  }

  async execute(request: AgentDelegationRequest): Promise<AgentDelegationResult> {
    const baseUrl = (
      this.opts.baseUrl ??
      process.env.OPENCLAW_BASE_URL ??
      "http://127.0.0.1:18789"
    ).replace(/\/$/, "");
    const token =
      this.opts.token ??
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      process.env.OPENCLAW_TOKEN ??
      "";
    const agentId = this.opts.agentId ?? process.env.OPENCLAW_DELEGATE_AGENT_ID;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (agentId) headers["x-openclaw-agent-id"] = agentId;

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: process.env.OPENCLAW_MODEL ?? "openclaw",
          stream: false,
          messages: [
            {
              role: "system",
              content:
                "You are an OpenClaw agent harness. Complete the delegated task and return a concise result.",
            },
            {
              role: "user",
              content: `[category=${request.taskCategory}]\n${request.taskDescription}\n\nContext:\n${request.conversationContext || "(none)"}`,
            },
          ],
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? 120_000),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string } | string;
      };
      if (!res.ok) {
        const err =
          typeof payload.error === "string"
            ? payload.error
            : payload.error?.message ?? `OpenClaw HTTP ${res.status}`;
        return {
          correlationId: request.correlationId,
          harnessId: this.manifest.id,
          status: "failed",
          output: "",
          error: err,
          metadata: { status: res.status },
        };
      }
      const output = payload.choices?.[0]?.message?.content ?? "";
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "completed",
        output,
        metadata: { agentId: agentId ?? null },
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

export function createOpenClawHarness(opts?: OpenClawHarnessOptions): OpenClawHarness {
  return new OpenClawHarness(opts);
}
