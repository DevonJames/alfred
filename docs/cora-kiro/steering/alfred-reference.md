# Alfred reference map

Alfred repo (read-only): the tree that contains `packages/core`, `packages/briefing`, `apps/voice-agent`.

Kiro should **open and reimplement** these files. Do not copy Graph, iOS, apple-stt, elgato, browser/X-ingest, OIP-local, or **any hosting/login** trees (`apps/desktop-client` host, `connect`, `pair`, `claim`, cloud-connect, device-store, sidecar).

## Architecture (read first)

| Topic | Alfred file |
| --- | --- |
| Conversation Core, LiveKit-as-transport | `docs/ARCHITECTURE.md` — ignore desktop/iOS pairing paragraphs |
| ADRs (pnpm, FSM, vendor-free contracts, Flux=evidence) | `docs/DECISIONS.md` |
| Cascaded stack versions | `docs/IMPLEMENTATION_PLAN.md` (M1 + M2 only) |
| Env template | `.env.example` — take voice + briefing keys only; drop Apple STT, cloud, Elgato, embeddings, sidecar, desktop identity paths |

Skip `README.md` product URLs, `docs/ios-desktop-pairing.md`, `docs/accountless-alfrd-net.md`, `docs/alfrd-net-desktop-handoff.md`.

## Conversation Core

| CORA module | Alfred source |
| --- | --- |
| Contracts / Zod | `packages/contracts/src/` |
| Session orchestrator (text) | `packages/core/src/session.ts` |
| Voice session | `packages/core/src/voice-session.ts` |
| FSM | `packages/core/src/state-machine.ts` |
| Response ledger | `packages/core/src/response-ledger.ts` |
| Event ledger | `packages/core/src/event-ledger.ts` |
| Sticky failover | `packages/core/src/failover.ts` |
| Prompt assembler (persona + memory + extras) | `packages/core/src/prompt-assembler.ts` |
| Interruption / backchannel | `packages/core/src/interruption.ts` |
| Echo filter + self-voice gate | `packages/core/src/echo-filter.ts`, `self-voice.ts` |
| TTS sentence chunker | `packages/core/src/tts-chunker.ts` |
| Weather utterance parse | `packages/core/src/weather-intent.ts` |
| Ports (Memory, Weather, Briefing) | `packages/core/src/ports.ts` |
| BriefingVoicePort | `packages/core/src/voice-session.ts` (`BriefingVoicePort`) |

Strip from Core while porting: `docs-ingest-intent.ts`, `x-ingest-intent.ts`, `studio-lights-intent.ts`, lights/reminder/structured-memory ports if unused. Keep `get_weather_forecast` and briefing ports.

## Providers and LiveKit

| CORA module | Alfred source |
| --- | --- |
| Registry + fakes | `packages/providers/` |
| Deepgram Flux | `packages/provider-deepgram/` |
| OpenAI Responses | `packages/provider-openai/` |
| Grok failover | `packages/provider-xai/` |
| ElevenLabs Flash | `packages/provider-elevenlabs/` |
| Room + PCM bridge + EnergyVad | `packages/livekit/src/` (`index.ts` lists public API) |
| Token helper (library only) | `packages/livekit/src/tokens.ts` — export for the **host** to call; do not wrap in an HTTP mint route |

Do **not** create `@cora/provider-apple-stt`. In voice wiring, if Deepgram key is missing, exit.

Alfred wiring to simplify: `apps/voice-agent/src/wiring.ts` (delete the `process.platform === "darwin"` Apple STT block) and `apps/voice-agent/src/brain.ts` (JSONL memory only; drop OIP, Elgato, X ingest harnesses).

## Memory (JSONL only)

| CORA module | Alfred source |
| --- | --- |
| LocalFileMemoryProvider | `packages/memory/src/local-provider.ts` |
| Fact extractor | `packages/memory/src/fact-extractor.ts` |
| MemoryController | `packages/memory/src/controller.ts` |
| Persona load/seed | `packages/memory/src/persona.ts`, `persona-templates.ts` |
| Tests | `packages/memory/src/local-provider.test.ts`, `fact-extractor.test.ts`, `persona.test.ts` |

Do **not** port `packages/memory/src/oip-local/`, embeddings, knowledge-ingest, photo-ingest, x-ingest, audio-note-ingest, graph dedupe.

Extend the fact extractor so utterances like “brief me about warehouse spend” / “I want to be briefed on failed jobs” upsert `fact:briefing-interest:*` records. Also allow USER.md directives for the same.

## Daily Brief

| CORA module | Alfred source |
| --- | --- |
| Prefs load/save | `packages/briefing/src/prefs.ts` — **replace** launches/crypto/metals with weather + news + analytics flags |
| Config / env | `packages/briefing/src/config.ts` |
| Types | `packages/briefing/src/types.ts` — drop launches, markets, xIngest; add analytics stub |
| Generate | `packages/briefing/src/generate.ts` |
| Speech vs markdown | `packages/briefing/src/format.ts`, `speech.ts` |
| Controller / soft offer | `packages/briefing/src/controller.ts` |
| Intent (“brief me”, yes/no) | `packages/briefing/src/intent.ts` — delete `wantsLaunches` |
| Day key 04:30 | `packages/briefing/src/day.ts` |
| Offer state.json | `packages/briefing/src/state.ts` |
| Day cache | `packages/briefing/src/cache.ts` |
| Weather Open-Meteo | `packages/briefing/src/weather.ts` — **port as-is** |
| Conversational weather | `packages/briefing/src/weather-lookup.ts` — **port as-is** |
| News RSS | `packages/briefing/src/news.ts` — **port catalog + fetch; honor includeNews** |
| Greeting | `packages/briefing/src/greeting.ts` — rename Alfred → CORA in the system prompt |
| Prefs form markup/logic | `apps/desktop-client/src/ui/briefing.html` — **form only**; replace launches/crypto/metals; ignore how Alfred serves the page |

Do **not** port `launches.ts`, `markets.ts`, `x-ingest.ts`, `reminders.ts` (not required for v1).

Do **not** port `apps/desktop-client/src/main.ts`, `routes/briefing.ts`, `routes/briefing-ui.ts`, `routes/conversation.ts`, `routes/token.ts`, `routes/connect.ts`, `routes/pair.ts`, `lib/device-store.ts`, `lib/cloud-connect.ts`, or `lib/text-session.ts` HTTP wrapping. Text turns go through `SessionOrchestrator` directly. Prefs go through `loadBriefingPrefs` / `saveBriefingPrefs`.

## Talk UI (module, not a host)

| CORA module | Alfred source |
| --- | --- |
| Talk UI | `apps/voice-client/src/main.ts` and related captions/waveform/composer |

Assume the host supplies `{ url, token, room, identity }` to the Talk UI. Do not copy desktop token routes or pairing.

## Voice runtime tools

Alfred live tools in `apps/voice-agent/src/live/tools.ts` (cascade session should expose the same capabilities even if GPT-Live is out of scope):

**Keep:** `get_weather_forecast`, `play_daily_briefing`, `decline_briefing_offer`, memory search/remember if present in cascade `VoiceSessionController`.

**Drop:** `control_studio_lights`, `show_expression`, X ingest, docs ingest, robot.

Cascade path: `VoiceSessionController` already intercepts weather intent and briefing via ports — prefer that over a second tool host.

## Tests worth porting

- `packages/briefing/src/intent.test.ts` (strip launch cases)
- `packages/briefing/src/prefs.test.ts` (new pref shape)
- `packages/briefing/src/weather` / `live-weather.test.ts`
- `packages/core/src/weather-intent.test.ts`
- `packages/memory/src/local-provider.test.ts`
- Voice-session briefing integration if present in `voice-session.test.ts`

## News RSS catalog (copy these URLs)

From `packages/briefing/src/news.ts`:

| Label | Feed |
| --- | --- |
| AP News | `https://apnews.com/index.rss` |
| BBC News | `https://feeds.bbci.co.uk/news/rss.xml` |
| CNN | `http://rss.cnn.com/rss/cnn_topstories.rss` |
| Fox News | `http://feeds.foxnews.com/foxnews/latest` |
| Bloomberg | `https://feeds.bloomberg.com/markets/news.rss` |
| Reuters | `https://www.reutersagency.com/feed/` |
| TechCrunch | `https://techcrunch.com/feed/` |
| Ars Technica | `https://feeds.arstechnica.com/arstechnica/index` |
| The Verge | `https://www.theverge.com/rss/index.xml` |
| Hacker News | `https://hnrss.org/frontpage` |
| NPR | `https://feeds.npr.org/1001/rss.xml` |
| The Guardian | `https://www.theguardian.com/world/rss` |

Alfred fetch rules (keep):

- Use the user’s selected source **names** in order
- Fetch at most **3** feeds, 8s timeout each, skip failures
- Parse `<title>` entries; skip channel/source titles and titles shorter than 12 chars
- Decode a handful of HTML entities; cap **8** unique headlines
- Speech: first **3** headlines, punctuation stripped, as `Top headlines: A. B. C.`
- Markdown: up to 6 bullets
- Prefs UI: user may check up to **10** sources; require at least one if news is enabled

## Weather (Open-Meteo — no key)

Port `packages/briefing/src/weather.ts`:

1. If lat/lon provided, use them. Else geocode `https://geocoding-api.open-meteo.com/v1/search?name=…&count=1`.
2. Forecast `https://api.open-meteo.com/v1/forecast` with current + daily WMO codes, Fahrenheit default, wind mph, precip inch, `forecast_days=7`.
3. Map WMO codes to condition strings (table in that file).
4. Speech: current temp/condition/feels-like, humidity/wind if notable, today high/low, tomorrow range, day-after condition.

Conversational tool: `lookupWeatherForecastSpeech` in `weather-lookup.ts`. Bare “what’s the weather” → home zip/coords. Named city/zip → override. 1–7 days.

Home location is required for both the brief’s weather section and the default tool. If missing, omit weather from the brief and have the tool say location is not configured.
