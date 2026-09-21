# Requirements: Daily Brief

**Feature:** Daily Brief preferences, weather, news, soft-offer delivery, Databricks stub  
**Depends on:** `01-platform-bootstrap`, `02-conversation`, `03-memory`

## Introduction

Users configure what goes into their Daily Brief. v1 sections are greeting, local date/time, weather, optional news headlines, and a Databricks analytics **seam** (implementation in a later spec). Rocket launches, crypto, metals, and X ingest are not included.

The preferences **UI module** and the `loadBriefingPrefs` / `saveBriefingPrefs` / `BriefingController` libraries are in scope. How that UI is hosted and who is allowed to save prefs is out of scope.

## Requirements

### Requirement 1: Briefing day and delivery

**User Story:** As a user, I want CORA to offer the brief once per morning and always play it when I ask.

#### Acceptance Criteria

1. THE briefing day key SHALL roll at local `CORA_BRIEFING_DAY_START` (default `04:30`), not midnight (Alfred `getBriefingDayKey`).
2. WHEN this is the first conversation of a briefing day and the brief has not been offered, played, or declined that day, THE SYSTEM SHALL soft-offer after a short reply: “Would you like the daily briefing now?”
3. WHEN the user explicitly asks (“brief me”, “daily brief”, “rundown”, “morning brief”, common typos of briefing), THE SYSTEM SHALL generate and return/play the brief even if they declined earlier that day.
4. WHEN an offer is pending and the user affirms (short yes/ok/go ahead), THE SYSTEM SHALL play the brief.
5. WHEN an offer is pending and the user declines (no/not now/skip), THE SYSTEM SHALL acknowledge (“Alright.”) and suppress further offers that briefing day.
6. Decline SHALL NOT block an explicit ask later the same day.
7. Offer state SHALL persist in `state.json` (`lastOfferedDay`, `lastDeclinedDay`, `lastPlayedDay`, `offerPending`).

### Requirement 2: Preferences model

**User Story:** As a user, I want a Daily Brief preferences UI where I set location, weather, news, and (later) analytics.

#### Acceptance Criteria

1. Prefs SHALL persist as JSON at `CORA_BRIEFING_PREFS_PATH` or `data/briefing/{profileId}/prefs.json`.
2. Prefs SHALL include at least:

   | Field | Meaning |
   | --- | --- |
   | `userName` | Spoken name in greeting |
   | `timezone` | IANA tz, default `America/Los_Angeles` |
   | `dayStart` | `HH:MM`, default `04:30` |
   | `zip` | Home zip or city string for weather geocode |
   | `latitude` / `longitude` | Preferred over zip when both set |
   | `includeWeather` | Whether to include weather in the brief |
   | `temperatureUnit` | `fahrenheit` (default) or `celsius` |
   | `includeNews` | Whether to include headlines |
   | `newsSources` | Selected catalog labels, max 10 |
   | `includeAnalytics` | Reserved; default true for when Databricks lands |
   | `analyticsNotes` | Freeform string passed to `AnalyticsProvider` (may be empty) |

3. Saved prefs SHALL win over env for UI-managed fields; env supplies defaults (`CORA_BRIEFING_ZIP`, `CORA_BRIEFING_LAT`/`LON`, `CORA_BRIEFING_TIMEZONE`, `CORA_BRIEFING_USER_NAME`, `CORA_BRIEFING_NEWS_SOURCES`).
4. THE SYSTEM SHALL NOT include launches, crypto, metals, or launch-site fields.

### Requirement 3: Preferences UI module

**User Story:** As a user, I can open Daily Brief preferences and save them without restarting the voice runtime.

#### Acceptance Criteria

1. THE UI SHALL let the user edit location (zip and/or lat/lon), timezone, day start, display name, include-weather, unit, include-news, and news sources.
2. News sources SHALL be a checkbox grid of the curated catalog (Alfred labels). User may select up to 10.
3. WHEN `includeNews` is on, THE UI SHALL require at least one source before save.
4. WHEN `includeNews` is off, sources MAY be retained but SHALL not be fetched.
5. THE UI SHALL show a placeholder section “Analytics (Databricks)” explaining that report selection will be configured later, plus an optional `analyticsNotes` textarea and `includeAnalytics` toggle.
6. Saving SHALL call `saveBriefingPrefs` and invalidate today’s briefing cache.
7. `BriefingController.generate` SHALL re-read prefs each call so a save applies without process restart.
8. THE UI SHALL NOT implement login. THE UI SHALL NOT depend on Alfred’s `/briefing/prefs` HTTP routes; the host may wrap the same load/save functions.

### Requirement 4: Weather section and live lookup

**User Story:** As a user, I want weather in my brief and when I ask CORA in conversation.

#### Acceptance Criteria

1. Weather SHALL use Open-Meteo (no API key): geocode `https://geocoding-api.open-meteo.com/v1/search`, forecast `https://api.open-meteo.com/v1/forecast` as in Alfred `packages/briefing/src/weather.ts`.
2. WHEN `includeWeather` is true and zip or lat/lon is set, THE brief SHALL include current condition/temp/feels-like, notable humidity/wind, today high/low, tomorrow range, day-after condition.
3. WHEN weather is off or location is missing, THE brief SHALL omit the weather section without failing the whole brief.
4. Conversational `get_weather_forecast` SHALL reuse the same fetch/formatters (`weather-lookup.ts`).
5. Speech SHALL be TTS-safe (no degree symbols required; “degrees”, spoken percents as in Alfred speech helpers).

### Requirement 5: News headlines and source selection

**User Story:** As a user, I want optional headlines from sources I pick.

#### Acceptance Criteria

1. THE catalog SHALL be the Alfred RSS map (AP News, BBC News, CNN, Fox News, Bloomberg, Reuters, TechCrunch, Ars Technica, The Verge, Hacker News, NPR, The Guardian).
2. WHEN `includeNews` is true, THE SYSTEM SHALL fetch selected sources **in order**, at most **3** feeds, 8s timeout, skip failures.
3. THE SYSTEM SHALL parse RSS `<title>` entries, skip channel/source titles and titles shorter than 12 characters, decode common HTML entities, and cap **8** unique headlines.
4. Spoken news SHALL be the top **3** headlines as `Top headlines: A. B. C.`
5. Markdown news SHALL list up to 6 bullets.
6. WHEN all feeds fail or `includeNews` is false, THE brief SHALL omit news without failing.
7. Default sources when unset: `AP News`, `BBC News`, `TechCrunch`.

### Requirement 6: Generate, cache, speech vs markdown

**User Story:** As a user, I hear a spoken rundown; as a reader I can see markdown.

#### Acceptance Criteria

1. `generateBriefing` SHALL produce `{ briefing, speech, markdown, generated }` with independent speech and markdown formatters (Alfred `format.ts` / `speech.ts`).
2. Speech order: short greeting (“Good morning, {name}.”) → weekday/date/time → weather (if any) → analytics stub/provider (if any) → news (if any) → short closing line.
3. Greeting SHALL be a 3–8 word salutation only; LLM greeting optional with Alfred `postProcessGreeting` guards so it does not restate weather/news.
4. Same-day results SHALL cache under `data/briefing/{profileId}/cache-{dayKey}.json` unless `refresh` is true or prefs just changed.
5. Failed optional sections SHALL degrade; THE SYSTEM SHALL NOT fail the whole brief if news or weather or analytics is down.
6. Speech SHALL NOT contain markdown, `$`, raw `%`, or emoji.

### Requirement 7: Databricks seam

**User Story:** As a platform owner, I will document Databricks reports later without rewriting the brief pipeline.

#### Acceptance Criteria

1. THE SYSTEM SHALL define `AnalyticsProvider` with `fetch(input: { dayKey, prefs, interests }): Promise<AnalyticsSection | null>`.
2. `AnalyticsSection` SHALL include `speech: string | null` and `markdown: string | null` (plus optional structured `items`).
3. The default provider SHALL return `null` and MUST NOT invent KPIs, BTC prices, or launches.
4. `interests` SHALL be briefing-interest memory facts plus `prefs.analyticsNotes`.
5. WHEN `includeAnalytics` is false, THE SYSTEM SHALL skip the provider.
6. THE SYSTEM SHALL NOT implement Databricks authentication, SQL warehouses, or report queries in this spec.

### Requirement 8: Memory-backed interests in the brief

**User Story:** As a user, things I told CORA I care about influence the analytics section once Databricks exists.

#### Acceptance Criteria

1. On generate, THE SYSTEM SHALL retrieve `fact:briefing-interest:*` (and USER.md is already in the voice prompt separately).
2. Those strings SHALL be passed into `AnalyticsProvider.fetch`.
3. Until the Databricks spec lands, THE brief MAY omit an interests spoken section rather than listing raw fact strings (avoid a dummy “you care about X” rundown unless product later wants it).
