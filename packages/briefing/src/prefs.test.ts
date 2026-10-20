import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadBriefingPrefs,
  resolveIncludeLaunches,
  saveBriefingPrefs,
} from "./prefs.js";

describe("resolveIncludeLaunches", () => {
  it("respects on/off/request", () => {
    expect(resolveIncludeLaunches("on", {})).toBe(true);
    expect(resolveIncludeLaunches("off", { userText: "brief me with launches" })).toBe(false);
    expect(resolveIncludeLaunches("request", { userText: "brief me" })).toBe(false);
    expect(resolveIncludeLaunches("request", { userText: "brief me with launches" })).toBe(true);
    expect(resolveIncludeLaunches("request", { requestFlag: true })).toBe(true);
  });
});

describe("briefing prefs file", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    delete process.env.BRIEFING_PREFS_PATH;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("round-trips prefs JSON", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-prefs-"));
    dirs.push(dir);
    process.env.BRIEFING_PREFS_PATH = path.join(dir, "prefs.json");
    await saveBriefingPrefs({
      launchesMode: "on",
      launchLocationIds: "11,27",
      includeCrypto: false,
      cryptoId: "ethereum",
      includeMetals: true,
      metalSymbol: "silver",
      includeIngestedNotes: false,
      includeMedicineMorning: true,
      includeMedicineMidday: true,
      includeMedicineEvening: true,
      newsSources: ["NPR", "BBC News"],
      agendaCalendarIds: ["work-cal"],
    });
    const loaded = await loadBriefingPrefs();
    expect(loaded.launchesMode).toBe("on");
    expect(loaded.launchLocationIds).toBe("11,27");
    expect(loaded.includeCrypto).toBe(false);
    expect(loaded.cryptoId).toBe("ethereum");
    expect(loaded.includeMetals).toBe(true);
    expect(loaded.metalSymbol).toBe("silver");
    expect(loaded.includeIngestedNotes).toBe(false);
    expect(loaded.includeMedicineMorning).toBe(true);
    expect(loaded.includeMedicineMidday).toBe(false);
    expect(loaded.includeMedicineEvening).toBe(false);
    expect(loaded.newsSources).toEqual(["NPR", "BBC News"]);
    expect(loaded.agendaCalendarIds).toEqual(["work-cal"]);
  });
});
