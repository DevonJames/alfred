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

  it("always explains that ingest is available via memory search", () => {
    const assembled = new PromptAssembler().assemble({
      systemInstructions: "You are ALFRED.",
      currentUserTurn: "what did that USPTO doc say?",
      recentConversation: [],
      retrievedMemory: [],
      mode: "initial",
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: [],
      dueReminders: [],
    });

    const system = assembled.messages[0]?.content ?? "";
    expect(assembled.notes).toContain("memory_access_model");
    expect(system).toMatch(/Memory access model/i);
    expect(system).toMatch(/ingested/i);
    expect(system).toMatch(/Never claim you lack access/i);
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

  it("includes get_weather_forecast guidance when capability is present", () => {
    const assembled = new PromptAssembler().assemble({
      systemInstructions: "You are ALFRED.",
      currentUserTurn: "what's the weather",
      recentConversation: [],
      retrievedMemory: [],
      mode: "initial",
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: ["delegate_task", "get_weather_forecast"],
      dueReminders: [],
    });
    const system = assembled.messages[0]?.content ?? "";
    expect(system).toContain("get_weather_forecast");
    expect(system).toMatch(/Do not invent temperatures/i);
    expect(system).toMatch(/do not ask which city/i);
    expect(system).toMatch(/no location argument/i);
  });

  it("includes control_studio_lights guidance when capability is present", () => {
    const assembled = new PromptAssembler().assemble({
      systemInstructions: "You are ALFRED.",
      currentUserTurn: "turn the lights down",
      recentConversation: [],
      retrievedMemory: [],
      mode: "initial",
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: ["delegate_task", "control_studio_lights"],
      dueReminders: [],
    });
    const system = assembled.messages[0]?.content ?? "";
    expect(system).toContain("control_studio_lights");
    expect(system).toMatch(/Do not claim you changed the lights/i);
    expect(system).toMatch(/omit target/i);
    expect(system).toMatch(/Do not mention Alfred:Home/i);
  });

  it("attaches extraSystem household extras", () => {
    const assembled = new PromptAssembler().assemble({
      systemInstructions: "You are ALFRED.",
      extraSystem: "CURRENT SCHEDULE CONTEXT:\n- 3pm dentist",
      currentUserTurn: "what's next",
      recentConversation: [],
      retrievedMemory: [],
      mode: "initial",
      lateAddenda: [],
      agentResults: [],
      availableCapabilities: ["delegate_task"],
    });
    const system = assembled.messages[0]?.content ?? "";
    expect(assembled.notes).toContain("extra_system_attached");
    expect(system).toContain("3pm dentist");
  });
});
