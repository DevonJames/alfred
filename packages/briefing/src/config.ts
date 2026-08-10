export interface BriefingConfig {
  profileId: string;
  timezone: string;
  dayStart: string;
  userName: string;
  zip: string | null;
  cryptoId: string;
  includeIndex: boolean;
  indexSymbol: "sp500" | "dow";
  includeMetals: boolean;
  metalSymbol: "gold" | "silver";
  newsSources: string[];
  llmGreeting: boolean;
  launchLocationIds: string;
  stateDir: string;
  cacheDir: string;
}

function envFlag(name: string, defaultOn: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return defaultOn;
  return v !== "0" && v.toLowerCase() !== "false" && v !== "off";
}

function parseDayStart(raw: string | undefined): string {
  const v = (raw ?? "04:30").trim();
  if (!/^\d{1,2}:\d{2}$/.test(v)) return "04:30";
  const [h, m] = v.split(":").map(Number);
  if (h! < 0 || h! > 23 || m! < 0 || m! > 59) return "04:30";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function loadBriefingConfig(overrides: Partial<BriefingConfig> = {}): BriefingConfig {
  const profileId = overrides.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const newsRaw =
    process.env.BRIEFING_NEWS_SOURCES ?? "AP News,BBC News,TechCrunch";
  const indexSymbol =
    process.env.BRIEFING_INDEX_SYMBOL === "dow" ? "dow" : "sp500";
  const metalSymbol =
    process.env.BRIEFING_METAL_SYMBOL === "silver" ? "silver" : "gold";

  return {
    profileId,
    timezone:
      overrides.timezone ??
      process.env.BRIEFING_TIMEZONE ??
      "America/Los_Angeles",
    dayStart: overrides.dayStart ?? parseDayStart(process.env.BRIEFING_DAY_START),
    userName: overrides.userName ?? process.env.BRIEFING_USER_NAME ?? "Devon",
    zip:
      overrides.zip !== undefined
        ? overrides.zip
        : process.env.BRIEFING_ZIP?.trim()
          ? process.env.BRIEFING_ZIP.trim()
          : null,
    cryptoId: overrides.cryptoId ?? process.env.BRIEFING_CRYPTO_ID ?? "bitcoin",
    includeIndex: overrides.includeIndex ?? envFlag("BRIEFING_INCLUDE_INDEX", false),
    indexSymbol: overrides.indexSymbol ?? indexSymbol,
    includeMetals: overrides.includeMetals ?? envFlag("BRIEFING_INCLUDE_METALS", false),
    metalSymbol: overrides.metalSymbol ?? metalSymbol,
    newsSources:
      overrides.newsSources ??
      newsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    llmGreeting: overrides.llmGreeting ?? envFlag("BRIEFING_LLM_GREETING", true),
    launchLocationIds:
      overrides.launchLocationIds ??
      process.env.BRIEFING_LAUNCH_LOCATION_IDS ??
      "11",
    stateDir:
      overrides.stateDir ??
      process.env.BRIEFING_STATE_DIR ??
      `./data/briefing/${profileId}`,
    cacheDir:
      overrides.cacheDir ??
      process.env.BRIEFING_CACHE_DIR ??
      `./data/briefing/${profileId}`,
  };
}
