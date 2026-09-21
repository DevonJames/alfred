# Design: Platform bootstrap

## Overview

Reimplement Alfred Conversation Core as `@cora/*` libraries. Skip Alfred’s desktop HTTP host and every login/pairing module.

Reference: Alfred `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` ADR-001 through ADR-012, `packages/core`, `packages/contracts`, `packages/persistence`, `packages/providers`.

## Package graph

```text
contracts
   ▲
   │
persistence (interfaces + in-memory)
   ▲
   │
core  ←── memory, briefing, agents (via ports)
   ▲
   │
provider-*  /  livekit  /  providers (fakes)
   ▲
   │
voice-agent  /  simulator
```

`apps/voice-client` is a UI module (spec 02). Daily Brief prefs UI is a module (spec 04). Neither is a host.

## Core components (port from Alfred)

| Component | Responsibility |
| --- | --- |
| `ConversationStateMachine` | Explicit states and domain events |
| `ResponseLedger` | Spoken vs unspoken vs abandoned |
| `EventLedger` | Append-only structured events |
| `StickyFailoverController` | Per-modality ordered lists |
| `PromptAssembler` | Persona + memory + extras |
| `SessionOrchestrator` | Text conversation loop |
| `VoiceSessionController` | Cascaded STT/LLM/TTS + interruption (wired in spec 02) |
| `SecretResolver` | `SecretRef` from env |

Strip while porting: docs-ingest intent, X-ingest intent, studio-lights intent, reminder/structured-memory/lights ports unless a later spec needs them. Keep weather + briefing ports as empty interfaces until specs 02 and 04.

## Pipeline

v1 is **cascaded only**. Unified realtime is deferred. Config shape matches Alfred: `mode: "cascaded"`, independent STT/LLM/TTS priority lists, `allowCascadedFallback: false`.

## Persistence

Repository interfaces for sessions, turns, ledgers, events, memory settings. In-memory implementations only. Durable files are JSONL + markdown + briefing JSON (specs 03–04).

## Env template (`.env.example`)

Include:

- `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
- `GROK_API_KEY` / `XAI_API_KEY` (optional)
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_ROOM=cora-dev`, `LIVEKIT_IDENTITY=cora-agent`
- `CORA_PROFILE_ID`, `CORA_MEMORY_PATH`, `CORA_PERSONA_DIR`
- Briefing location: `CORA_BRIEFING_ZIP`, `CORA_BRIEFING_LAT`, `CORA_BRIEFING_LON`, `CORA_BRIEFING_TIMEZONE`, `CORA_BRIEFING_DAY_START`, `CORA_BRIEFING_USER_NAME`

Exclude: Apple STT, `ALFRD_*`, sidecar, Elgato, embeddings, desktop identity/devices paths.

## Testing

- Unit tests for FSM transitions, ledger buckets, failover sticky behavior, prompt assembly order.
- Simulator scenarios: simple Q&A, interruption abandon, memory recall after restart (after spec 03).
- No live-network tests in default CI.

## Hosting / login

Out of design. Do not add Hono, `@hono/node-server`, claim HTML, or token routes.
