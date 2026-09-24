import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BriefingController } from "./controller.js";

describe("BriefingController soft offer policy", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("offers once, declines, then still plays on explicit ask", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-brief-ctl-"));
    dirs.push(dir);
    // 2026-08-10 12:00 UTC = 05:00 PDT → briefing day 2026-08-10
    const now = new Date("2026-08-10T12:00:00.000Z");

    const ctl = new BriefingController(null, {
      profileId: "test",
      stateDir: dir,
      cacheDir: dir,
      llmGreeting: false,
      zip: null,
    });

    const first = await ctl.handleUserTurn("hey alfred", now);
    expect(first.action).toBe("chat");
    if (first.action === "chat") expect(first.appendOffer).toBe(true);

    const decline = await ctl.handleUserTurn("not now", now);
    expect(decline.action).toBe("decline");

    const secondChat = await ctl.handleUserTurn("what's 2+2", now);
    expect(secondChat.action).toBe("chat");
    if (secondChat.action === "chat") expect(secondChat.appendOffer).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })),
    );
    try {
      const play = await ctl.handleUserTurn("brief me bud", now);
      expect(play.action).toBe("play");
      if (play.action === "play") {
        expect(play.speech.length).toBeGreaterThan(0);
        expect(play.speech).not.toMatch(/\[icon:/);
        expect(Array.isArray(play.newsHeadlines)).toBe(true);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resetSoftOffer re-arms soft offer after play", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-brief-ctl-"));
    dirs.push(dir);
    const now = new Date("2026-08-10T12:00:00.000Z");

    const ctl = new BriefingController(null, {
      profileId: "test",
      stateDir: dir,
      cacheDir: dir,
      llmGreeting: false,
      zip: null,
    });

    const first = await ctl.handleUserTurn("hey alfred", now);
    expect(first.action).toBe("chat");
    if (first.action === "chat") expect(first.appendOffer).toBe(true);

    await ctl.markPlayed(now);
    expect(await ctl.shouldSoftOffer(now)).toBe(false);

    await ctl.resetSoftOffer(now);
    expect(await ctl.shouldSoftOffer(now)).toBe(true);

    const again = await ctl.handleUserTurn("morning", now);
    expect(again.action).toBe("chat");
    if (again.action === "chat") expect(again.appendOffer).toBe(true);
  });

  it("reset from another process re-arms cascade/live controllers via generation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-brief-ctl-"));
    dirs.push(dir);
    const now = new Date("2026-08-10T12:00:00.000Z");
    const opts = {
      profileId: "test",
      stateDir: dir,
      cacheDir: dir,
      llmGreeting: false as const,
      zip: null,
    };

    // Simulates voice-agent (cascade / GPT-Live) after it already offered+played.
    const voice = new BriefingController(null, opts);
    await voice.markOffered(now);
    await voice.markPlayed(now);
    expect(await voice.shouldSoftOffer(now)).toBe(false);

    // Simulates Brief-tab Reset on the desktop process.
    const desktop = new BriefingController(null, opts);
    await desktop.resetSoftOffer(now);

    // Voice worker must notice the generation bump without a restart.
    expect(await voice.shouldSoftOffer(now)).toBe(true);
  });
});
