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
});
