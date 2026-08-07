import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { LocalFileMemoryProvider } from "./local-provider.js";

describe("LocalFileMemoryProvider", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  async function tempProvider(): Promise<LocalFileMemoryProvider> {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-mem-"));
    dirs.push(dir);
    return new LocalFileMemoryProvider(path.join(dir, "profile.jsonl"));
  }

  it("persists facts across provider instances (restart)", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "alfred-mem-")), "p.jsonl");
    dirs.push(path.dirname(file));

    const a = new LocalFileMemoryProvider(file);
    await a.commitTurn({
      profileId: "p1",
      sessionId: "s1",
      turnId: "t1",
      role: "user",
      text: "Hello, my name is Devon.",
      metadata: {},
    });
    await a.commitTurn({
      profileId: "p1",
      sessionId: "s1",
      turnId: "t2",
      role: "user",
      text: "I'm a software developer.",
      metadata: {},
    });

    const b = new LocalFileMemoryProvider(file);
    const name = await b.retrieve({ text: "What is my name?", limit: 5 });
    expect(name.items.some((i) => i.content.includes("Devon"))).toBe(true);
    expect(name.items.some((i) => i.sourceId === "fact:name")).toBe(true);

    const job = await b.retrieve({ text: "What is my job?", limit: 5 });
    expect(job.items.some((i) => i.sourceId === "fact:job")).toBe(true);
  });

  it("backfills facts from older user turns on load", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "alfred-mem-")), "p.jsonl");
    dirs.push(path.dirname(file));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify({
        id: "mem_old",
        content: "user: Remember that the garage code is 9999.",
        sourceId: "t_old",
        providerId: "memory.local",
        createdAt: "2026-01-01T00:00:00.000Z",
        provenance: { kind: "turn", role: "user", profileId: "p1", sessionId: "s0" },
      }) + "\n",
      "utf8",
    );

    const p = new LocalFileMemoryProvider(file);
    const result = await p.retrieve({ text: "Do you remember the garage code?", limit: 5 });
    expect(result.items.some((i) => /9999/.test(i.content))).toBe(true);
  });

  it("prefers facts over unrelated turns for name queries", async () => {
    const p = await tempProvider();
    await p.commitTurn({
      profileId: "p1",
      sessionId: "s1",
      turnId: "t1",
      role: "user",
      text: "The weather is nice today and I talked about many things.",
      metadata: {},
    });
    await p.commitTurn({
      profileId: "p1",
      sessionId: "s1",
      turnId: "t2",
      role: "user",
      text: "My name is Devon.",
      metadata: {},
    });

    const result = await p.retrieve({ text: "What's my name?", limit: 3 });
    expect(result.items[0]?.sourceId).toBe("fact:name");
  });

  it("upserts name fact on repeat", async () => {
    const p = await tempProvider();
    await p.commitTurn({
      profileId: "p1",
      sessionId: "s1",
      turnId: "t1",
      role: "user",
      text: "My name is Devon.",
      metadata: {},
    });
    await p.commitTurn({
      profileId: "p1",
      sessionId: "s1",
      turnId: "t2",
      role: "user",
      text: "Actually my name is Alex.",
      metadata: {},
    });
    const inspected = await p.inspect(50);
    const names = inspected.filter((i) => i.sourceId === "fact:name");
    expect(names).toHaveLength(1);
    expect(names[0]?.content).toContain("Alex");
  });

  it("exports and imports canonical records", async () => {
    const p = await tempProvider();
    await p.commitTurn({
      profileId: "p1",
      sessionId: "s1",
      turnId: "t1",
      role: "user",
      text: "Remember that coffee is at 8am",
      metadata: {},
    });
    const exported = await p.exportCanonical();
    expect(exported.length).toBeGreaterThan(0);

    const q = await tempProvider();
    await q.importCanonical(exported);
    const again = await q.inspect(20);
    expect(again.some((i) => i.content.toLowerCase().includes("coffee"))).toBe(true);
  });
});
