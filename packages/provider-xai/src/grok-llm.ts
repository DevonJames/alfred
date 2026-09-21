import type {
  LLMProvider,
  LlmGenerateRequest,
  LlmModelPreset,
  LlmReasoningEffort,
  LlmStreamChunk,
  ProviderFailureClass,
  ProviderHealth,
  ProviderManifest,
} from "@alfred/contracts";
import OpenAI from "openai";

export const XAI_GROK_PROVIDER_ID = "llm.xai.grok";

/** Default chat model — Grok 4.6 (override with ALFRED_VOICE_GROK_MODEL). */
export const DEFAULT_GROK_MODEL = "grok-4.6";

const XAI_BASE_URL = "https://api.x.ai/v1";

export interface XaiGrokOptions {
  apiKey: string;
  /** Override model id (default grok-4.6 / ALFRED_VOICE_GROK_MODEL). */
  model?: string;
  /** Inject stream factory for tests (no network). */
  streamFactory?: (request: LlmGenerateRequest) => AsyncIterable<LlmStreamChunk>;
}

const PRESET_EFFORT: Record<LlmModelPreset, LlmReasoningEffort> = {
  instant: "none",
  conversational: "none",
  deliberate: "low",
};

/**
 * xAI Grok chat-completions adapter (OpenAI-compatible).
 * Used as sticky LLM failover when OpenAI Terra is unavailable (credits, 5xx, etc.).
 */
export class XaiGrokLLMProvider implements LLMProvider {
  readonly manifest: ProviderManifest = {
    id: XAI_GROK_PROVIDER_ID,
    displayName: "xAI Grok 4.6",
    kind: "llm",
    version: "0.1.0",
    capabilities: ["chat", "streaming", "function_calling"],
  };

  private readonly client: OpenAI;
  private readonly model: string;

  constructor(private readonly options: XaiGrokOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: XAI_BASE_URL,
    });
    this.model =
      options.model?.trim() ||
      process.env.ALFRED_VOICE_GROK_MODEL?.trim() ||
      DEFAULT_GROK_MODEL;
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.options.apiKey) {
      return {
        providerId: this.manifest.id,
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        failureClass: "auth",
        message: "GROK_API_KEY / XAI_API_KEY missing",
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
    const effort = request.reasoningEffort ?? PRESET_EFFORT[preset];

    try {
      const tools = request.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      }));

      const messages = toChatMessages(request);
      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        stream: true,
        ...(tools?.length ? { tools } : {}),
      };
      // xAI accepts reasoning_effort on recent Grok models; "none" → omit / low.
      if (effort && effort !== "none") {
        body.reasoning_effort = effort;
      }

      const stream = (await this.client.chat.completions.create(
        body as unknown as Parameters<typeof this.client.chat.completions.create>[0],
      )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

      const toolAcc = new Map<number, { name: string; args: string }>();

      for await (const event of stream) {
        if (request.signal?.aborted) {
          yield { type: "error", error: "aborted", failureClass: "unknown" };
          return;
        }
        const choice = event.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          yield { type: "token", text: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolAcc.get(idx) ?? { name: "", args: "" };
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolAcc.set(idx, cur);
          }
        }
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
          for (const cur of toolAcc.values()) {
            if (!cur.name) continue;
            let toolArgs: Record<string, unknown> = {};
            try {
              toolArgs = cur.args ? (JSON.parse(cur.args) as Record<string, unknown>) : {};
            } catch {
              toolArgs = { raw: cur.args };
            }
            yield { type: "tool_call", toolName: cur.name, toolArgs };
          }
          toolAcc.clear();
        }
      }
      yield { type: "done" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: message, failureClass: classifyXaiFailure(message) };
    }
  }
}

export function classifyXaiFailure(message: string): ProviderFailureClass {
  if (/credit|quota|billing|insufficient|balance|exhausted/i.test(message)) return "unavailable";
  if (/rate.?limit|429/i.test(message)) return "rate_limit";
  if (/auth|api.?key|401|403/i.test(message)) return "auth";
  if (/timeout|ETIMEDOUT|AbortError/i.test(message)) return "timeout_total";
  if (/ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(message)) return "connection";
  return "upstream_5xx";
}

function toChatMessages(
  request: LlmGenerateRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  let lastUserIndex = -1;
  for (let i = 0; i < request.messages.length; i++) {
    if (request.messages[i]?.role === "user") lastUserIndex = i;
  }
  const images = (request.imageDataUrls ?? []).filter(Boolean);

  return request.messages.map((m, index) => {
    if (m.role === "tool") {
      return { role: "user" as const, content: m.content };
    }
    if (m.role === "user" && index === lastUserIndex && images.length > 0) {
      return {
        role: "user" as const,
        content: [
          { type: "text" as const, text: m.content },
          ...images.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ],
      };
    }
    if (m.role === "system" || m.role === "user" || m.role === "assistant") {
      return { role: m.role, content: m.content };
    }
    return { role: "user" as const, content: m.content };
  });
}

export function resolveGrokApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.GROK_API_KEY?.trim() || env.XAI_API_KEY?.trim() || undefined;
}
