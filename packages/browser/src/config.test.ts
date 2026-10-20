import { describe, expect, it } from "vitest";
import { loadBrowserConfig, parseBrowserChannel, resolveCuaMode } from "./config.js";
import { profileLockErrorMessage, rewriteProfileLockError } from "./playwright-capture.js";

describe("browser config", () => {
  it("defaults CUA to fallback and chrome channel", () => {
    delete process.env.ALFRED_X_CUA;
    delete process.env.ALFRED_BROWSER_CHANNEL;
    expect(resolveCuaMode()).toBe("fallback");
    delete process.env.ALFRED_BROWSER_HEADLESS;
    const cfg = loadBrowserConfig({ userDataDir: "/tmp/alfred-browser" });
    expect(cfg.channel).toBe("chrome");
    expect(cfg.cua).toBe("fallback");
    expect(cfg.headless).toBe(false);
  });

  it("only runs headless when ALFRED_BROWSER_HEADLESS=1", () => {
    process.env.ALFRED_BROWSER_HEADLESS = "1";
    expect(loadBrowserConfig({ userDataDir: "/tmp/alfred-browser" }).headless).toBe(true);
    delete process.env.ALFRED_BROWSER_HEADLESS;
  });

  it("honors ALFRED_BROWSER_CHANNEL=brave", () => {
    process.env.ALFRED_BROWSER_CHANNEL = "brave";
    expect(loadBrowserConfig({ userDataDir: "/tmp/alfred-browser" }).channel).toBe("brave");
    delete process.env.ALFRED_BROWSER_CHANNEL;
  });

  it("parses chrome and brave only", () => {
    expect(parseBrowserChannel("brave")).toBe("brave");
    expect(parseBrowserChannel("CHROME")).toBe("chrome");
    expect(parseBrowserChannel("safari")).toBeUndefined();
  });
});

describe("profile lock errors", () => {
  it("rewrites Playwright ProcessSingleton failures into a close-the-login-window hint", () => {
    const err = new Error(
      "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory.",
    );
    const rewritten = rewriteProfileLockError(err, "/tmp/alfred-profile");
    expect(rewritten.message).toBe(profileLockErrorMessage("/tmp/alfred-profile"));
    expect(rewritten.message).toMatch(/ingest-x-login/);
  });
});
