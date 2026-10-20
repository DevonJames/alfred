import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyModuleSettings,
  assertPublicHttpsUrl,
  createBriefingModuleFromAsk,
  listBriefingModules,
  looksLikeAddBriefingModule,
  parseBriefingModule,
  rocketLaunchesModule,
  runEnabledBriefingModules,
  saveBriefingModule,
  setBriefingModuleEnabled,
} from "./modules.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alfred-modules-"));
  dirs.push(dir);
  return dir;
}

describe("looksLikeAddBriefingModule", () => {
  it("matches a request to extend the briefing", () => {
    expect(looksLikeAddBriefingModule("add upcoming rocket launches to my briefing")).toBe(true);
    expect(looksLikeAddBriefingModule("brief me")).toBe(false);
    expect(looksLikeAddBriefingModule("what's in the news")).toBe(false);
  });
});

describe("parseBriefingModule", () => {
  it("accepts a public https module", () => {
    const module = parseBriefingModule(rocketLaunchesModule());
    expect(module.id).toBe("rocket-launches");
    expect(applyModuleSettings(module)).toContain("location__ids=11");
  });

  it("rejects private and non-https urls", () => {
    expect(() => assertPublicHttpsUrl("http://example.com/a")).toThrow(/https/);
    expect(() => assertPublicHttpsUrl("https://127.0.0.1/a")).toThrow(/public/);
    expect(() => assertPublicHttpsUrl("https://192.168.1.4/a")).toThrow(/public/);
  });
});

describe("module disk store", () => {
  it("writes a module beside briefing data and can disable it", async () => {
    const root = await tempRoot();
    const saved = await saveBriefingModule(rocketLaunchesModule(), "profile.default", root);
    expect(saved.enabled).toBe(true);
    const listed = await listBriefingModules("profile.default", root);
    expect(listed.map((module) => module.id)).toEqual(["rocket-launches"]);
    const off = await setBriefingModuleEnabled("rocket-launches", false, "profile.default", root);
    expect(off.enabled).toBe(false);
  });

  it("drafts from the model and saves the file", async () => {
    const root = await tempRoot();
    const { speech, module } = await createBriefingModuleFromAsk({
      request: "add upcoming rocket launches to my briefing",
      root,
      fetchImpl: async () =>
        Response.json({
          results: [
            {
              name: "Falcon 9 Block 5 | Starlink",
              net: "2026-10-20T23:09:23Z",
              launch_service_provider: { name: "SpaceX", url: "https://example.com" },
              mission: { name: "Starlink Group 15-15" },
              pad: { name: "SLC-4E", location: { name: "Vandenberg SFB" } },
            },
          ],
        }),
      llm: async (messages) => {
        const system = messages[0]?.content ?? "";
        if (system.includes("Summarize briefing data")) {
          return JSON.stringify({
            speech: "SpaceX's Starlink Group 15-15 lifts off Tuesday at 7:09pm from Vandenberg.",
            lines: ["Tue 7:09pm — Starlink Group 15-15, Vandenberg"],
          });
        }
        return JSON.stringify({
          id: "rocket-launches",
          title: "Rocket launches",
          fetch: {
            method: "GET",
            url: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5&location__ids={{sites}}",
          },
          settings: [{ key: "sites", label: "Sites", type: "text", default: "11" }],
          speech: "Speak the next launch in one sentence.",
        });
      },
    });
    expect(module.id).toBe("rocket-launches");
    expect(speech).toMatch(/Rocket launches/);
    expect(speech).toMatch(/Vandenberg/);
    expect(await listBriefingModules("profile.default", root)).toHaveLength(1);
  });

  it("still briefs a launch when the summary model returns nothing", async () => {
    const root = await tempRoot();
    await saveBriefingModule(rocketLaunchesModule(), "profile.default", root);
    const results = await runEnabledBriefingModules({
      profileId: "profile.default",
      root,
      llm: async () => '{"speech":"","lines":[]}',
      fetchImpl: async () =>
        Response.json({
          count: 51,
          next: "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?offset=5",
          results: [
            {
              id: "abc",
              url: "https://ll.thespacedevs.com/2.2.0/launch/abc/",
              name: "Falcon 9 Block 5 | Starlink Group 15-15",
              net: "2026-10-20T23:09:23Z",
              launch_service_provider: { name: "SpaceX" },
              mission: { name: "Starlink Group 15-15" },
              pad: { name: "Space Launch Complex 4E", location: { name: "Vandenberg SFB, CA, USA" } },
            },
          ],
        }),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.speech).toMatch(/SpaceX/);
    expect(results[0]?.speech).toMatch(/Vandenberg/);
  });
});
