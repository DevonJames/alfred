import { describe, expect, it } from "vitest";
import { conversationForSchedule, noteConversationTurn, resetConversationThread } from "./conversation-thread.js";

describe("conversation thread", () => {
  it("keeps earlier user lines for a later schedule request", () => {
    resetConversationThread();
    const start = Date.parse("2026-09-27T16:00:00.000Z");
    noteConversationTurn("user", "I'm gonna be finished making lunch in about 10 minutes.", start);
    noteConversationTurn("assistant", "Okay.", start + 1_000);
    noteConversationTurn("user", "I'd like to talk to Maddie for about 30 minutes while I'm eating lunch.", start + 2_000);
    noteConversationTurn("user", "just saying adjust things so that I can squeeze in talking to Maddie in about 10 minutes.", start + 3_000);
    const thread = conversationForSchedule(start + 4_000);
    expect(thread).toMatch(/finished making lunch/);
    expect(thread).toMatch(/Maddie for about 30 minutes/);
    expect(thread).toMatch(/squeeze in talking to Maddie/);
    expect(thread.endsWith("squeeze in talking to Maddie in about 10 minutes.")).toBe(true);
    resetConversationThread();
  });
});
