import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultBriefingDataDir } from "@alfred/memory";
import type { BriefingConfig, LaunchesMode } from "./config.js";
import { loadBriefingConfig } from "./config.js";
import { wantsLaunches } from "./intent.js";

export type { LaunchesMode };

/** User-editable Daily Brief preferences (persisted JSON). */
export interface BriefingPrefs {
  launchesMode: LaunchesMode;
  /** Comma-separated Launch Library location IDs. */
  launchLocationIds: string;
  includeCrypto: boolean;
  cryptoId: string;
  includeMetals: boolean;
  metalSymbol: "gold" | "silver";
  newsSources: string[];
}

export const CRYPTO_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "bitcoin", label: "Bitcoin" },
  { id: "ethereum", label: "Ethereum" },
  { id: "solana", label: "Solana" },
  { id: "cardano", label: "Cardano" },
  { id: "ripple", label: "XRP" },
  { id: "dogecoin", label: "Dogecoin" },
];

/** Curated SpaceDevs location IDs for the preferences UI. */
export const LAUNCH_SITE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "11", label: "Vandenberg SFB, CA" },
  { id: "27", label: "Cape Canaveral / CCSFS, FL" },
  { id: "14", label: "Wallops Flight Facility, VA" },
  { id: "18", label: "Starbase (Boca Chica), TX" },
  { id: "15", label: "Kennedy Space Center, FL" },
];

export function defaultBriefingPrefs(): BriefingPrefs {
  return {
    launchesMode: "request",
    launchLocationIds: "11",
    includeCrypto: true,
    cryptoId: "bitcoin",
    includeMetals: false,
    metalSymbol: "gold",
    newsSources: ["AP News", "BBC News", "TechCrunch"],
  };
}

export function prefsPath(profileId?: string): string {
  const id = profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const override = process.env.BRIEFING_PREFS_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(defaultBriefingDataDir(id), "prefs.json");
}

function normalizePrefs(raw: Partial<BriefingPrefs> | null | undefined): BriefingPrefs {
  const d = defaultBriefingPrefs();
  if (!raw || typeof raw !== "object") return d;

  const mode = raw.launchesMode;
  const launchesMode: LaunchesMode =
    mode === "on" || mode === "off" || mode === "request" ? mode : d.launchesMode;

  const metalSymbol =
    raw.metalSymbol === "silver" || raw.metalSymbol === "gold"
      ? raw.metalSymbol
      : d.metalSymbol;

  const newsSources = Array.isArray(raw.newsSources)
    ? raw.newsSources.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 10)
    : d.newsSources;

  const launchLocationIds =
    typeof raw.launchLocationIds === "string" && raw.launchLocationIds.trim()
      ? raw.launchLocationIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(",")
      : d.launchLocationIds;

  const cryptoId =
    typeof raw.cryptoId === "string" && raw.cryptoId.trim()
      ? raw.cryptoId.trim().toLowerCase()
      : d.cryptoId;

  return {
    launchesMode,
    launchLocationIds: launchLocationIds || d.launchLocationIds,
    includeCrypto: raw.includeCrypto !== undefined ? Boolean(raw.includeCrypto) : d.includeCrypto,
    cryptoId,
    includeMetals: raw.includeMetals !== undefined ? Boolean(raw.includeMetals) : d.includeMetals,
    metalSymbol,
    newsSources: newsSources.length ? newsSources : d.newsSources,
  };
}

export async function loadBriefingPrefs(profileId?: string): Promise<BriefingPrefs> {
  try {
    const raw = await readFile(prefsPath(profileId), "utf8");
    return normalizePrefs(JSON.parse(raw) as Partial<BriefingPrefs>);
  } catch {
    return defaultBriefingPrefs();
  }
}

export async function saveBriefingPrefs(
  prefs: BriefingPrefs,
  profileId?: string,
): Promise<BriefingPrefs> {
  const normalized = normalizePrefs(prefs);
  const file = prefsPath(profileId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

/** Env defaults + saved prefs (prefs win for UI-managed fields). */
export async function resolveBriefingConfig(
  overrides: Partial<BriefingConfig> = {},
): Promise<BriefingConfig> {
  const profileId =
    overrides.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const prefs = await loadBriefingPrefs(profileId);
  return loadBriefingConfig({
    profileId,
    launchesMode: prefs.launchesMode,
    launchLocationIds: prefs.launchLocationIds,
    includeCrypto: prefs.includeCrypto,
    cryptoId: prefs.cryptoId,
    includeMetals: prefs.includeMetals,
    metalSymbol: prefs.metalSymbol,
    newsSources: prefs.newsSources,
    ...overrides,
  });
}

/**
 * - on: always
 * - off: never
 * - request: when user text asks for launches, or HTTP ?launches=1
 */
export function resolveIncludeLaunches(
  mode: LaunchesMode,
  opts: { userText?: string; requestFlag?: boolean } = {},
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  if (opts.requestFlag === true) return true;
  if (opts.userText) return wantsLaunches(opts.userText);
  return false;
}
