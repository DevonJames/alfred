# Design: Daily Brief

## Overview

Port Alfred `@alfred/briefing` Stage 1, then **delete** launches, markets, X ingest, and reminders. Add `includeNews`, weather toggles, and `AnalyticsProvider`.

Reference files (behavior, not HTTP):

- `packages/briefing/src/{controller,prefs,config,types,generate,format,speech,intent,day,state,cache,weather,weather-lookup,news,greeting}.ts`
- Prefs form markup: `apps/desktop-client/src/ui/briefing.html` (form only)

Do not port `apps/desktop-client/src/routes/briefing.ts` or `briefing-ui.ts`.

## Prefs shape

```ts
export interface BriefingPrefs {
  userName: string;
  timezone: string;
  dayStart: string; // HH:MM
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  includeWeather: boolean;
  temperatureUnit: "fahrenheit" | "celsius";
  includeNews: boolean;
  newsSources: string[];
  includeAnalytics: boolean;
  analyticsNotes: string;
}
```

`resolveBriefingConfig()` = env defaults + saved prefs (prefs win). Controller re-reads on every `generate` / `handleUserTurn`.

## Controller

Keep Alfred `BriefingTurnDecision`: `play` | `decline` | `chat`. Soft-offer eligibility: not yet offered/played/declined for `dayKey`; first turn of process may still gate as Alfred does (`firstTurnOfProcess`) — port that behavior.

Intent: keep `ASK_PATTERNS`, `AFFIRM_RE`, `DECLINE_RE`. Delete `wantsLaunches` and launch location flags.

## Generate pipeline

```text
resolve config + dayKey
  → cache hit? return
  → greeting (time-of-day ± LLM salutation)
  → weather if includeWeather && location
  → analytics if includeAnalytics → AnalyticsProvider.fetch
  → news if includeNews → fetchNewsHeadlines(newsSources)
  → format speech + markdown
  → cache set
```

Parallelize weather, news, and analytics with `Promise.all`. Any one may return null.

## News

Copy `RSS_URLS` and `fetchNewsHeadlines` / `formatNewsSpeech` / `formatNewsMarkdown` from Alfred. Gate on `includeNews`. If enabled and `newsSources` is empty, use defaults.

## Weather

Copy `weather.ts` and `weather-lookup.ts` almost verbatim. Thread `temperatureUnit` into `fetchWeather(location, useCelsius, coords)`.

## Analytics stub

```ts
export interface AnalyticsSection {
  items?: Array<{ title: string; summary: string }>;
  speech: string | null;
  markdown: string | null;
}

export interface AnalyticsFetchInput {
  dayKey: string;
  prefs: BriefingPrefs;
  interests: string[];
}

export interface AnalyticsProvider {
  fetch(input: AnalyticsFetchInput): Promise<AnalyticsSection | null>;
}

export function createNullAnalyticsProvider(): AnalyticsProvider {
  return { async fetch() { return null; } };
}
```

`generateBriefing` accepts `analytics?: AnalyticsProvider`. Default null provider. Follow-on Databricks spec replaces this module only.

## Speech order

1. Greeting + name  
2. “It is {weekday}, {month day} at {clock}.”  
3. Weather speech  
4. Analytics speech (when non-null)  
5. News speech  
6. Closing line (Alfred `closingLine`)

No crypto, launches, X ingest, reminders in v1.

## Prefs UI module

A self-contained form (HTML or whatever the host uses) that:

1. Calls `loadBriefingPrefs` + catalog (`NEWS_SOURCE_OPTIONS`)
2. Renders sections: Location & weather, News sources, Analytics (placeholder)
3. Calls `saveBriefingPrefs` then `BriefingController.invalidateTodayCache`

Do not add rocket/crypto/metals sections. Do not add Graph/Claim chrome.

## Testing

- Intent: explicit ask, affirm, decline, “brief me” after decline still plays  
- Prefs JSON round-trip including `includeNews` / `newsSources`  
- News parser skips feed titles  
- Weather formatter speech contains high/low  
- `generateBriefing` with includeNews false has empty news  
- Null analytics does not throw  
- Cache invalidation after save  
