import type {
  LLMProvider,
  LlmGenerateRequest,
  LlmStreamChunk,
  ProviderFailureClass,
  ProviderHealth,
  ProviderManifest,
} from "@alfred/contracts";
import type { Clock } from "@alfred/core";

export interface FakeLlmScript {
  /** Static reply, or function of last user message. */
  reply?: string | ((userText: string) => string);
  /** Fail for the first N calls with this class. */
  failTimes?: number;
  failureClass?: ProviderFailureClass;
  /** Delay before first token. */
  firstTokenDelayMs?: number;
  healthy?: boolean;
}

export class FakeLLMProvider implements LLMProvider {
  readonly manifest: ProviderManifest;
  private failRemaining: number;
  private callCount = 0;
  healthy: boolean;
  private firstTokenDelayMs: number;

  constructor(
    id: string,
    private readonly script: FakeLlmScript = {},
    private readonly clock?: Clock,
    displayName?: string,
  ) {
    this.manifest = {
      id,
      displayName: displayName ?? id,
      kind: "llm",
      version: "0.1.0",
      capabilities: ["chat", "streaming"],
    };
    this.failRemaining = script.failTimes ?? 0;
    this.healthy = script.healthy ?? true;
    this.firstTokenDelayMs = script.firstTokenDelayMs ?? 0;
  }

  setFirstTokenDelayMs(ms: number): void {
    this.firstTokenDelayMs = ms;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.manifest.id,
      status: this.healthy ? "healthy" : "unhealthy",
      checkedAt: this.clock?.nowIso() ?? new Date().toISOString(),
    };
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  async *generateStream(request: LlmGenerateRequest): AsyncIterable<LlmStreamChunk> {
    this.callCount += 1;
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      yield {
        type: "error",
        error: `Fake LLM ${this.manifest.id} failed`,
        failureClass: this.script.failureClass ?? "upstream_5xx",
      };
      return;
    }

    if (this.firstTokenDelayMs > 0 && this.clock) {
      await this.clock.sleep(this.firstTokenDelayMs, request.signal as AbortSignal | undefined);
    }

    const userText = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const system = request.messages.find((m) => m.role === "system")?.content ?? "";

    let reply: string;
    if (typeof this.script.reply === "function") {
      reply = this.script.reply(userText);
    } else if (this.script.reply) {
      reply = this.script.reply;
    } else if (system.includes("Mode=addendum")) {
      reply = `Addendum note regarding: ${userText}`;
    } else if (system.includes("Mode=clarification")) {
      reply = "Could you clarify what you meant?";
    } else if (system.includes("Mode=replacement") || system.includes("Mode=continuation")) {
      reply = `Regarding your interruption (${userText}): acknowledged.`;
    } else if (system.includes("Agent harness results")) {
      reply = `I completed the delegated task. Result summary follows.`;
    } else {
      reply = `Echo: ${userText}`;
    }

    for (const word of reply.split(/(\s+)/)) {
      if (!word) continue;
      yield { type: "token", text: word };
    }
    yield { type: "done" };
  }

  getCallCount(): number {
    return this.callCount;
  }
}
