import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentHarness,
  AgentHarnessManifest,
  TaskCategory,
} from "@alfred/contracts";

export interface StubHarnessOptions {
  id: string;
  displayName: string;
  capabilities: AgentHarnessManifest["capabilities"];
  notes?: string;
  /** Fail first N executions for failover tests. */
  failTimes?: number;
  failMessage?: string;
}

export class StubAgentHarness implements AgentHarness {
  readonly manifest: AgentHarnessManifest;
  private failRemaining: number;
  private executions = 0;

  constructor(private readonly opts: StubHarnessOptions) {
    this.manifest = {
      id: opts.id,
      displayName: opts.displayName,
      version: "0.1.0",
      capabilities: opts.capabilities,
      notes: opts.notes,
    };
    this.failRemaining = opts.failTimes ?? 0;
  }

  supports(category: TaskCategory): boolean {
    return (
      this.manifest.capabilities.includes(category as never) ||
      this.manifest.capabilities.includes("general") ||
      (category === "computer_use" && this.manifest.capabilities.includes("computer_use"))
    );
  }

  async execute(request: AgentDelegationRequest): Promise<AgentDelegationResult> {
    this.executions += 1;
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      return {
        correlationId: request.correlationId,
        harnessId: this.manifest.id,
        status: "failed",
        output: "",
        error: this.opts.failMessage ?? `${this.manifest.id} stub failure`,
        metadata: { stub: true },
      };
    }
    return {
      correlationId: request.correlationId,
      harnessId: this.manifest.id,
      status: "completed",
      output: `[${this.manifest.id}] Completed ${request.taskCategory}: ${request.taskDescription}`,
      metadata: { stub: true, executions: this.executions },
    };
  }

  getExecutions(): number {
    return this.executions;
  }
}

export function createOpenClawStub(failTimes = 0): StubAgentHarness {
  return new StubAgentHarness({
    id: "harness.openclaw",
    displayName: "OpenClaw (stub)",
    capabilities: ["email", "calendar", "browser", "computer_use", "messaging", "general"],
    notes: "Future: Gateway agent APIs. Stub only in M1.",
    failTimes,
  });
}

export function createHermesStub(failTimes = 0): StubAgentHarness {
  return new StubAgentHarness({
    id: "harness.hermes",
    displayName: "Hermes (stub)",
    capabilities: ["browser", "computer_use", "research", "general"],
    notes: "Future: headless JSON-RPC/WebSocket server. Stub only in M1.",
    failTimes,
  });
}

export function createCodexStub(failTimes = 0): StubAgentHarness {
  return new StubAgentHarness({
    id: "harness.codex",
    displayName: "Codex (stub)",
    capabilities: ["coding", "repository", "filesystem", "shell"],
    notes: "Coding/repo/fs/shell harness — not general desktop automation.",
    failTimes,
  });
}

export function createClaudeStub(failTimes = 0): StubAgentHarness {
  return new StubAgentHarness({
    id: "harness.claude",
    displayName: "Claude Agent (stub)",
    capabilities: ["computer_use", "browser", "research", "general"],
    notes: "Future: Agent SDK / computer-use via app-supplied execution environment.",
    failTimes,
  });
}
