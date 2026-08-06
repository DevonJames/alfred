import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentHarness,
  AgentRoutingRule,
  TaskCategory,
} from "@alfred/contracts";
import type { AgentRouterPort } from "@alfred/core";

/**
 * Routes normalized delegate_task requests to harnesses by category priority lists.
 * Does not expose harness-specific tool schemas to the conversational LLM.
 */
export class AgentRouter implements AgentRouterPort {
  private readonly harnesses = new Map<string, AgentHarness>();
  private rules: AgentRoutingRule[] = [];

  register(harness: AgentHarness): void {
    this.harnesses.set(harness.manifest.id, harness);
  }

  setRoutingRules(rules: AgentRoutingRule[]): void {
    this.rules = [...rules];
  }

  getRoutingRules(): AgentRoutingRule[] {
    return [...this.rules];
  }

  listHarnesses(): AgentHarness[] {
    return [...this.harnesses.values()];
  }

  async delegate(request: AgentDelegationRequest): Promise<AgentDelegationResult> {
    const ordered = this.orderedHarnessIds(request.taskCategory);
    if (ordered.length === 0) {
      return {
        correlationId: request.correlationId,
        harnessId: "none",
        status: "failed",
        output: "",
        error: `No harness routing configured for category ${request.taskCategory}`,
        metadata: {},
      };
    }

    let lastFailure: AgentDelegationResult | undefined;
    for (const id of ordered) {
      const harness = this.harnesses.get(id);
      if (!harness) continue;
      if (!harness.supports(request.taskCategory)) continue;
      const result = await harness.execute(request);
      if (result.status !== "failed") {
        return result;
      }
      lastFailure = result;
    }

    return (
      lastFailure ?? {
        correlationId: request.correlationId,
        harnessId: "none",
        status: "failed",
        output: "",
        error: `All harnesses failed for category ${request.taskCategory}`,
        metadata: {},
      }
    );
  }

  private orderedHarnessIds(category: TaskCategory): string[] {
    const rule = this.rules.find((r) => r.category === category);
    if (rule) return rule.orderedHarnessIds;
    // Default: any harness that declares support, stable by registration order.
    return [...this.harnesses.values()]
      .filter((h) => h.supports(category))
      .map((h) => h.manifest.id);
  }
}
