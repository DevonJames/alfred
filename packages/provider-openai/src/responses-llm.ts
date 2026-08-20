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
      const tools = request.tools?.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? { type: "object", properties: {} },
      }));
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
        input: request.messages.map((m, index) => {
          let lastUserIndex = -1;
          for (let i = 0; i < request.messages.length; i++) {
            if (request.messages[i]?.role === "user") lastUserIndex = i;
          }
          const isLastUser = m.role === "user" && index === lastUserIndex;
          const images = isLastUser ? (request.imageDataUrls ?? []).filter(Boolean) : [];
          if (images.length === 0) {
            return {
              role: m.role === "tool" ? "user" : m.role,
              content: m.content,
            };
          }
          return {
            role: "user" as const,
            content: [
              { type: "input_text", text: m.content },
              ...images.map((url) => ({ type: "input_image", image_url: url })),
            ],
          };
        }),
        stream: true,
        reasoning: { effort },
        previous_response_id: request.previousResponseId,
        ...(tools?.length ? { tools } : {}),
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
  if (type === "response.output_item.done" || type === "response.function_call_arguments.done") {
    const item = (event.item ?? event) as Record<string, unknown>;
    const itemType = String(item.type ?? "");
    const name = String(item.name ?? "");
    const argsRaw = item.arguments ?? item.parsed_arguments;
    if (itemType === "function_call" || name) {
      let toolArgs: Record<string, unknown> = {};
      if (typeof argsRaw === "string") {
        try {
          toolArgs = JSON.parse(argsRaw) as Record<string, unknown>;
        } catch {
          toolArgs = { raw: argsRaw };
        }
      } else if (argsRaw && typeof argsRaw === "object") {
        toolArgs = argsRaw as Record<string, unknown>;
      }
      if (name) return { type: "tool_call", toolName: name, toolArgs };
    }
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
