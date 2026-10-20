/**
 * Lightweight settings store for iOS Settings / privacy mode.
 */
import type { BrowserChannel } from "@alfred/browser";
import { parseBrowserChannel } from "@alfred/browser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type PrivacyMode = "local_only" | "private_hybrid" | "user_managed";
export type VoiceMode = "cascaded" | "unified";

export interface DesktopSettingsFile {
  privacyMode: PrivacyMode;
  voiceMode: VoiceMode;
  browserChannel: BrowserChannel;
}

const DEFAULTS: DesktopSettingsFile = {
  privacyMode: "private_hybrid",
  voiceMode: "cascaded",
  browserChannel: "chrome",
};

const RANK: Record<PrivacyMode, number> = {
  local_only: 0,
  private_hybrid: 1,
  user_managed: 2,
};

function settingsPath(): string {
  const override = process.env.ALFRED_DESKTOP_SETTINGS_PATH;
  if (override) return resolve(override);
  return resolve(process.cwd(), "../../data/desktop-client/settings.json");
}

export async function loadDesktopSettings(): Promise<DesktopSettingsFile> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopSettingsFile>;
    return {
      privacyMode:
        parsed.privacyMode === "local_only" ||
        parsed.privacyMode === "private_hybrid" ||
        parsed.privacyMode === "user_managed"
          ? parsed.privacyMode
          : DEFAULTS.privacyMode,
      voiceMode: parsed.voiceMode === "unified" ? "unified" : "cascaded",
      browserChannel: parseBrowserChannel(parsed.browserChannel) ?? DEFAULTS.browserChannel,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...DEFAULTS };
    throw err;
  }
}

export async function saveDesktopSettings(next: DesktopSettingsFile): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** Phone may only tighten privacy (lower rank). Returns null if the patch is rejected. */
export function applyPrivacyTighten(
  current: PrivacyMode,
  requested: PrivacyMode,
): PrivacyMode | null {
  if (RANK[requested] > RANK[current]) return null;
  return requested;
}

export function privacyRank(mode: PrivacyMode): number {
  return RANK[mode];
}
