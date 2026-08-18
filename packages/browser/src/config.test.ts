import { describe, expect, it } from "vitest";
import { loadBrowserConfig, resolveCuaMode } from "./config.js";

describe("browser config", () => {
  it("defaults CUA to fallback and chrome channel", () => {
    delete process.env.ALFRED_X_CUA;
    delete process.env.ALFRED_BROWSER_CHANNEL;
    expect(resolveCuaMode()).toBe("fallback");
    const cfg = loadBrowserConfig({ userDataDir: "/tmp/alfred-browser" });
    expect(cfg.channel).toBe("chrome");
    expect(cfg.cua).toBe("fallback");
  });
});
