import { describe, expect, it } from "vitest";
import { classifyXaiFailure, XaiGrokLLMProvider } from "./grok-llm.js";

describe("classifyXaiFailure", () => {
  it("maps credit exhaustion to unavailable", () => {
    expect(classifyXaiFailure("credit_balance_exhausted")).toBe("unavailable");
    expect(classifyXaiFailure("insufficient_quota")).toBe("unavailable");
  });

  it("maps rate limits and auth", () => {
    expect(classifyXaiFailure("Rate limit exceeded")).toBe("rate_limit");
    expect(classifyXaiFailure("Invalid API key")).toBe("auth");
  });
});

describe("XaiGrokLLMProvider", () => {
  it("streams tokens from streamFactory", async () => {
    const provider = new XaiGrokLLMProvider({
      apiKey: "test",
      streamFactory: async function* () {
        yield { type: "token", text: "Hello" };
        yield { type: "done" };
      },
    });
    const chunks: string[] = [];
    for await (const chunk of provider.generateStream({
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.type === "token" && chunk.text) chunks.push(chunk.text);
    }
    expect(chunks).toEqual(["Hello"]);
  });

  it("reports unhealthy without api key", async () => {
    const provider = new XaiGrokLLMProvider({ apiKey: "" });
    const health = await provider.healthCheck();
    expect(health.status).toBe("unhealthy");
    expect(health.failureClass).toBe("auth");
  });
});
