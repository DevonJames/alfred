import type {
  LLMProvider,
  LlmGenerateRequest,
  LlmModelPreset,
  LlmReasoningEffort,
  LlmStreamChunk,
  ProviderHealth,
  ProviderManifest,
} from "@alfred/contracts";
import OpenAI from "openai";

export const OPENAI_TERRA_PROVIDER_ID = "llm.openai.terra";

export interface OpenAiResponsesOptions {
  apiKey: string;
  /** Inject stream factory for tests (no network). */
  streamFactory?: (request: LlmGenerateRequest) => AsyncIterable<LlmStreamChunk>;
}

const PRESET_MODELS: Record<LlmModelPreset, { model: string; effort: LlmReasoningEffort }> = {
  instant: { model: "gpt-5.6-luna", effort: "none" },
  conversational: { model: "gpt-5.6-terra", effort: "none" },
  deliberate: { model: "gpt-5.6-terra", effort: "low" },
};

/**
 * OpenAI Responses API adapter. Vendor SDK stays inside this package.
 * Default Conversational: gpt-5.6-terra, reasoning.effort=none.
 */
export class OpenAiResponsesLLMProvider implements LLMProvider {
  readonly manifest: ProviderManifest = {
    id: OPENAI_TERRA_PROVIDER_ID,
    displayName: "OpenAI GPT-5.6 Terra (Responses)",
    kind: "llm",
    version: "0.2.0",
    capabilities: ["chat", "streaming", "responses_api", "function_calling"],
  };

  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiResponsesOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.options.apiKey) {
      return {
        providerId: this.manifest.id,
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        failureClass: "auth",
        message: "OPENAI_API_KEY missing",
      };
    }
    return {
      providerId: this.manifest.id,
      status: "healthy",
      checkedAt: new Date().toISOString(),
    };
  }

  async *generateStream(request: LlmGenerateRequest): AsyncIterable<LlmStreamChunk> {
    if (this.options.streamFactory) {
      yield* this.options.streamFactory(request);
      return;
    }

    const preset = request.modelPreset ?? "conversational";
    const mapped = PRESET_MODELS[preset];
    const model = mapped.model;
    const effort = request.reasoningEffort ?? mapped.effort;

    try {
      // Responses API streaming — shape may evolve; keep translation local.
      const stream = await (
        this.client as unknown as {
          responses: {
            create: (
              body: Record<string, unknown>,
            ) => Promise<AsyncIterable<Record<string, unknown>>>;
          };
        }
      ).responses.create({
        model,
        input: request.messages.map((m) => ({
          role: m.role === "tool" ? "user" : m.role,
          content: m.content,
        })),
        stream: true,
        reasoning: { effort },
        previous_response_id: request.previousResponseId,
      });

      for await (const event of stream) {
        if (request.signal?.aborted) {
          yield { type: "error", error: "aborted", failureClass: "unknown" };
          return;
        }
        const chunk = mapResponsesEvent(event);
        if (chunk) yield chunk;
      }
      yield { type: "done" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failureClass = /rate/i.test(message)
        ? "rate_limit"
        : /auth|api key/i.test(message)
          ? "auth"
          : "upstream_5xx";
      yield { type: "error", error: message, failureClass };
    }
  }
}

export function resolvePreset(preset: LlmModelPreset): {
  model: string;
  effort: LlmReasoningEffort;
} {
  return PRESET_MODELS[preset];
}

export function mapResponsesEvent(event: Record<string, unknown>): LlmStreamChunk | undefined {
  const type = String(event.type ?? "");
  if (
    type === "response.output_text.delta" ||
    type === "response.text.delta" ||
    type === "content.delta"
  ) {
    const text = (event.delta as string | undefined) ?? (event as { text?: string }).text ?? "";
    if (text) return { type: "token", text };
  }
  if (type === "response.completed" || type === "response.done") {
    return { type: "done" };
  }
  if (type === "error" || type === "response.failed") {
    return {
      type: "error",
      error: String((event as { message?: string }).message ?? "responses error"),
      failureClass: "upstream_5xx",
    };
  }
  // Some SDKs yield { type: 'token', text }
  if (event.text && (type === "token" || !type)) {
    return { type: "token", text: String(event.text) };
  }
  return undefined;
}
