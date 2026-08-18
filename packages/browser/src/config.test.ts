import { describe, expect, it } from "vitest";
import { loadBrowserConfig, resolveCuaMode } from "./config.js";
import { profileLockErrorMessage, rewriteProfileLockError } from "./playwright-capture.js";

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
