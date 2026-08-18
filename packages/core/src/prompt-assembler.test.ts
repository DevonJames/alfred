import { describe, expect, it } from "vitest";
import { PromptAssembler } from "./prompt-assembler.js";

describe("PromptAssembler persona", () => {
  it("injects SOUL / IDENTITY / USER before retrieved memory", () => {
    const assembled = new PromptAssembler().assemble({
      systemInstructions: "You are ALFRED.",
      currentUserTurn: "hi",
      recentConversation: [],
      personaContext: {
        soul: "Be concise.",
        identity: "Name: ALFRED",
        user: "Prefer short answers.",
      },
      retrievedMemory: [
        {
          id: "m1",
          content: "User likes tea.",
          sourceId: "fact:pref",
          providerId: "memory.local",
          provenance: { kind: "fact" },
        },
      ],
      mode: "initial",
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: ["delegate_task"],
      dueReminders: [],
    });

    const system = assembled.messages[0]?.content ?? "";
    expect(assembled.notes).toEqual(
      expect.arrayContaining(["soul_attached", "identity_attached", "user_model_attached"]),
    );
    const soulAt = system.indexOf("SOUL.md");
    const memAt = system.indexOf("Retrieved long-term memory");
    expect(soulAt).toBeGreaterThan(-1);
    expect(memAt).toBeGreaterThan(soulAt);
    expect(system).toContain("Be concise.");
    expect(system).toContain("Prefer short answers.");
  });

  it("attaches due reminders and update_reminder guidance", () => {
    const assembled = new PromptAssembler().assemble({
      systemInstructions: "You are ALFRED.",
      currentUserTurn: "I signed the offer letter",
      recentConversation: [],
      mode: "initial",
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: ["delegate_task", "update_reminder"],
      dueReminders: [
        {
          recordId: "did:memory:hr1",
          summary: "Check with HR about the formal offer letter",
          remindAt: "2026-08-10",
          status: "surfaced",
        },
      ],
      retrievedMemory: [],
    });

    const system = assembled.messages[0]?.content ?? "";
    expect(assembled.notes).toContain("due_reminders_attached");
    expect(system).toContain("update_reminder");
    expect(system).toContain("did:memory:hr1");
    expect(system).toContain("formal offer letter");
    expect(system).toContain("delegate_task");
  });
});
