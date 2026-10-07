import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore, resetConversationStoreCache } from "./store.js";

describe("ConversationStore", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    resetConversationStoreCache();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function freshStore(): Promise<ConversationStore> {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-conv-"));
    dirs.push(dir);
    return new ConversationStore(dir);
  }

  it("reuses active conversation within idle window", async () => {
    const store = await freshStore();
    const t0 = new Date("2026-09-29T12:00:00.000Z");
    const first = await store.ensureActive({ now: t0, stack: "live2" });
    await store.appendMessage({
      conversationId: first.id,
      role: "user",
      text: "hello there",
      source: "voice",
      stack: "live2",
      now: t0,
    });

    const t1 = new Date("2026-09-29T12:20:00.000Z");
    const again = await store.ensureActive({ now: t1, idleMergeMs: 30 * 60_000 });
    expect(again.id).toBe(first.id);
  });

  it("creates a new conversation after idle expires", async () => {
    const store = await freshStore();
    const t0 = new Date("2026-09-29T12:00:00.000Z");
    const first = await store.ensureActive({ now: t0 });
    await store.appendMessage({
      conversationId: first.id,
      role: "user",
      text: "hi",
      source: "voice",
      now: t0,
    });

    const t1 = new Date("2026-09-29T12:30:01.000Z");
    const next = await store.ensureActive({ now: t1, idleMergeMs: 30 * 60_000 });
    expect(next.id).not.toBe(first.id);
  });

  it("forceNew always creates a fresh conversation", async () => {
    const store = await freshStore();
    const t0 = new Date("2026-09-29T12:00:00.000Z");
    const first = await store.ensureActive({ now: t0 });
    await store.appendMessage({
      conversationId: first.id,
      role: "user",
      text: "hi",
      source: "text",
      now: t0,
    });
    await store.prepareNew();
    const next = await store.ensureActive({ now: new Date("2026-09-29T12:01:00.000Z") });
    expect(next.id).not.toBe(first.id);
  });

  it("upgrades modality to mixed when voice and text appear", async () => {
    const store = await freshStore();
    const t0 = new Date("2026-09-29T12:00:00.000Z");
    const { conversation: afterVoice } = await store.appendMessage({
      role: "user",
      text: "spoken hello",
      source: "voice",
      stack: "cascade",
      now: t0,
    });
    expect(afterVoice.modality).toBe("voice");
    expect(afterVoice.title).toMatch(/spoken hello/i);

    const { conversation: afterText } = await store.appendMessage({
      conversationId: afterVoice.id,
      role: "user",
      text: "typed follow-up",
      source: "text",
      now: new Date("2026-09-29T12:01:00.000Z"),
    });
    expect(afterText.modality).toBe("mixed");

    const listed = await store.list();
    expect(listed[0]?.id).toBe(afterText.id);
    expect(listed[0]?.modality).toBe("mixed");
  });

  it("setActive resumes a past conversation", async () => {
    const store = await freshStore();
    const a = await store.createNew({ stack: "live" });
    await store.appendMessage({
      conversationId: a.id,
      role: "user",
      text: "first chat",
      source: "text",
    });
    const b = await store.createNew({ stack: "live" });
    await store.appendMessage({
      conversationId: b.id,
      role: "user",
      text: "second chat",
      source: "text",
    });
    expect(await store.getActiveId()).toBe(b.id);

    const resumed = await store.setActive(a.id);
    expect(resumed?.id).toBe(a.id);
    expect(await store.getActiveId()).toBe(a.id);

    const { conversation } = await store.appendMessage({
      role: "assistant",
      text: "resumed reply",
      source: "text",
    });
    expect(conversation.id).toBe(a.id);
    expect(conversation.messages.some((m) => m.text === "resumed reply")).toBe(true);
  });
});
