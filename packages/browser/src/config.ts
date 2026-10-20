import { existsSync } from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "@alfred/memory";

export type BrowserChannel = "chrome" | "brave" | "chromium";
export type CuaMode = "fallback" | "always" | "off";

export interface BrowserConfig {
  userDataDir: string;
  channel: BrowserChannel;
  executablePath?: string;
  headless: boolean;
  cua: CuaMode;
}

export function defaultBrowserUserDataDir(): string {
  const fromEnv = process.env.ALFRED_BROWSER_USER_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(resolveRepoRoot(), "data", "browser", "alfred-profile");
}

export function parseBrowserChannel(raw: string | undefined): BrowserChannel | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "brave" || value === "chromium" || value === "chrome") return value;
  return undefined;
}

export function resolveBrowserChannel(): BrowserChannel {
  return parseBrowserChannel(process.env.ALFRED_BROWSER_CHANNEL) ?? "chrome";
}

export function browserDisplayName(channel: BrowserChannel): string {
  if (channel === "brave") return "Brave";
  if (channel === "chromium") return "Chromium";
  return "Chrome";
}

export function chromeExecutable(): string | undefined {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  return candidates.find((p) => existsSync(p));
}

export function installedBrowserChannels(): Array<{
  id: BrowserChannel;
  name: string;
  installed: boolean;
}> {
  return [
    { id: "chrome", name: "Chrome", installed: Boolean(chromeExecutable()) },
    { id: "brave", name: "Brave", installed: Boolean(braveExecutable()) },
  ];
}

export function resolveCuaMode(): CuaMode {
  const raw = (process.env.ALFRED_X_CUA ?? "fallback").toLowerCase();
  if (raw === "always" || raw === "off" || raw === "fallback") return raw;
  return "fallback";
}

export function braveExecutable(): string | undefined {
  const candidates = [
    process.env.ALFRED_BROWSER_EXECUTABLE?.trim(),
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/brave-browser",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p));
}

export function loadBrowserConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  const channel = overrides.channel ?? resolveBrowserChannel();
  return {
    userDataDir: overrides.userDataDir ?? defaultBrowserUserDataDir(),
    channel,
    executablePath:
      overrides.executablePath ?? (channel === "brave" ? braveExecutable() : undefined),
    headless: overrides.headless ?? process.env.ALFRED_BROWSER_HEADLESS === "1",
    cua: overrides.cua ?? resolveCuaMode(),
  };
}
