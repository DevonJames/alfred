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
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
