import { describe, expect, it } from "vitest";
import { mapResponsesEvent, resolvePreset } from "./responses-llm.js";

describe("OpenAI Responses adapter helpers", () => {
  it("resolves conversational preset to terra + none", () => {
    expect(resolvePreset("conversational")).toEqual({
      model: "gpt-5.6-terra",
      effort: "none",
    });
  });

  it("resolves instant and deliberate presets", () => {
    expect(resolvePreset("instant").model).toBe("gpt-5.6-luna");
    expect(resolvePreset("deliberate")).toEqual({
      model: "gpt-5.6-terra",
      effort: "low",
    });
  });

  it("maps function call items to tool_call chunks", () => {
    expect(
      mapResponsesEvent({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "delegate_task",
          arguments: '{"category":"research","taskDescription":"ingest my X notes"}',
        },
      }),
    ).toEqual({
      type: "tool_call",
      toolName: "delegate_task",
      toolArgs: { category: "research", taskDescription: "ingest my X notes" },
    });
  });

  it("maps text delta events to tokens", () => {
    expect(mapResponsesEvent({ type: "response.output_text.delta", delta: "Hi" })).toEqual({
      type: "token",
      text: "Hi",
    });
  });
});
