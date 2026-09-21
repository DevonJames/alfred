# CORA product

CORA is an onsite conversational assistant for knowledge work. Conversation is the primary runtime. Memory and briefing are services the conversation runtime invokes — they are not a second product.

## Identity

- **Name:** CORA
- **Creature:** Voice-first work companion with a typed-chat fallback
- **Vibe:** Calm, precise, lightly dry. Concise when speaking. Thorough in text when asked.
- **Not:** a chatbot wrapper, a dashboard, or a second brain graph UI

Seed `IDENTITY.md` with the name CORA. Seed `SOUL.md` with work-appropriate boundaries (no leaking internal data, no inventing metrics). Seed `USER.md` with communication-style directives and briefing interests.

## Surfaces (v1)

These are **product capabilities**, not a prescribed host, server, or login scheme. The host application (out of this pack) mounts them.

| Surface | Purpose |
| --- | --- |
| Talk | LiveKit uplink UI: waveform, captions, mic mute, typed composer in the same voice session |
| Chat | Same conversation core, text in / text out (`SessionOrchestrator`) |
| Daily Brief | Preferences UI + generate/play today’s brief (voice soft-offer or explicit “brief me”) |

The cascaded voice runtime joins a LiveKit room as `cora-agent`. How users reach Talk/Chat/Brief, how they authenticate, and how processes are deployed are **not specified here**.

## User promises

1. The user can talk or type and get one coherent CORA.
2. CORA remembers stable facts and briefing preferences across restarts.
3. The Daily Brief is configurable: location/weather, news on/off + sources, and (later) Databricks analytics.
4. Weather is available both in the brief and as a live “what’s the weather” tool.
5. Nothing in v1 requires a Mac, an iPhone, or a robot.

## Delivery of the Daily Brief

Preserve Alfred Stage-1 delivery, renamed:

- Briefing day rolls at a local wall-clock (`CORA_BRIEFING_DAY_START`, default `04:30`), not midnight.
- First conversation of a briefing day: answer concisely, then soft-offer (“Would you like the daily briefing now?”).
- Explicit ask (“brief me”, “daily brief”, “rundown”) always generates and speaks/returns the brief.
- Decline suppresses the offer for that briefing day only.
- Speech is a separate TTS-safe string from markdown/display. No `$`, `%`, emoji, or markdown in the spoken payload.

## Databricks

The **shape** of the brief includes an analytics section. The **content** (which Databricks reports, how to query them, how to narrate them) arrives in a separate document. Until then, `AnalyticsProvider.fetch()` returns `null` and the brief degrades without that section. Do not invent BTC, launches, or placeholder fake KPIs.
