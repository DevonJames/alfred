import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatTalkFocusSystem,
  readTalkFocus,
  TALK_FOCUS_MAX_AGE_MS,
  writeTalkFocus,
} from "./talk-focus.js";

describe("talk focus", () => {
  const prev = process.env.ALFRED_TALK_FOCUS_PATH;
  const dirs: string[] = [];

  afterEach(async () => {
    if (prev === undefined) delete process.env.ALFRED_TALK_FOCUS_PATH;
    else process.env.ALFRED_TALK_FOCUS_PATH = prev;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("persists a focus and formats it for the voice prompt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-talk-focus-"));
    dirs.push(dir);
    process.env.ALFRED_TALK_FOCUS_PATH = path.join(dir, "talk-focus.json");
    await writeTalkFocus({
      did: "did:memory:abc",
      name: "ADHD briefing",
      type: "Entity",
      text: "Dopamine is chronically low.",
      setAt: "2026-10-17T15:00:00.000Z",
    });
    const hit = await readTalkFocus(Date.parse("2026-10-17T15:10:00.000Z"));
    expect(hit?.name).toBe("ADHD briefing");
    const prompt = formatTalkFocusSystem(hit!);
    expect(prompt).toContain("GRAPH TALK FOCUS");
    expect(prompt).toContain("Dopamine is chronically low.");
    expect(prompt).toContain("did:memory:abc");
  });

  it("ignores a stale focus", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-talk-focus-"));
    dirs.push(dir);
    process.env.ALFRED_TALK_FOCUS_PATH = path.join(dir, "talk-focus.json");
    await writeTalkFocus({
      did: "did:memory:old",
      name: "Old",
      type: "Entity",
      text: "gone",
      setAt: "2026-10-16T00:00:00.000Z",
    });
    const later = Date.parse("2026-10-16T00:00:00.000Z") + TALK_FOCUS_MAX_AGE_MS + 1000;
    expect(await readTalkFocus(later)).toBeNull();
  });
});
