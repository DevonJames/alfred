export {
  OPENAI_TERRA_PROVIDER_ID,
  OpenAiResponsesLLMProvider,
  classifyOpenAiFailure,
  mapResponsesEvent,
  resolvePreset,
  type OpenAiResponsesOptions,
} from "./responses-llm.js";

/** Documented LLM priority — Grok is the registered OpenAI failover. */
export const RECOMMENDED_LLM_PRIORITY = [
  "llm.openai.terra",
  "llm.xai.grok",
  "llm.openai.luna", // stub — model fallback within OpenAI
  "llm.local.low_latency", // stub — emergency
] as const;
