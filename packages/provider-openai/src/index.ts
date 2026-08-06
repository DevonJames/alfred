export {
  OPENAI_TERRA_PROVIDER_ID,
  OpenAiResponsesLLMProvider,
  mapResponsesEvent,
  resolvePreset,
  type OpenAiResponsesOptions,
} from "./responses-llm.js";

/** Documented LLM priority (Groq/Luna/local stubs until implemented). */
export const RECOMMENDED_LLM_PRIORITY = [
  "llm.openai.terra",
  "llm.groq.gpt_oss_120b", // stub — provider failover
  "llm.openai.luna", // stub — model fallback within OpenAI
  "llm.local.low_latency", // stub — emergency
] as const;
