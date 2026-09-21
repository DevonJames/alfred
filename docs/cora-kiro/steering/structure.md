# CORA monorepo structure

pnpm workspaces: `packages/*` and `apps/*`.

```text
packages/contracts         Provider-neutral Zod schemas and types
packages/core              FSM, ledgers, failover, prompt assembly, SessionOrchestrator, VoiceSessionController
packages/providers         Registry + fake STT/LLM/TTS (tests / text path fallback)
packages/provider-deepgram Deepgram Flux STT
packages/provider-openai   OpenAI Responses LLM
packages/provider-xai      Grok LLM failover (optional)
packages/provider-elevenlabs ElevenLabs Flash TTS
packages/livekit           Room session + media bridge (transport only)
packages/memory            JSONL LocalFileMemoryProvider + persona files + MemoryController
packages/briefing          Daily brief: prefs, weather, news, controller, Databricks stub
packages/persistence       Repository interfaces + in-memory implementations
packages/agents            Thin AgentRouter + stub harness (delegate_task only; no X ingest)

apps/voice-agent           Cascaded voice runtime (joins LiveKit as cora-agent)
apps/voice-client          Talk UI module (waveform, captions, composer)
apps/simulator             Text-only CLI scenarios (recommended; Alfred M1 pattern)
```

Do **not** create an Alfred-style desktop HTTP host, claim/pair app, or iOS client. The host application consumes these packages.

## Dependency rule

Adapters and apps depend on `contracts` / `core`. Core depends on `contracts` and persistence **interfaces**. Vendor SDKs never appear in `contracts` or `core`.

`@cora/briefing` may depend on `@cora/memory` later; v1 briefing does **not** need OIP. Prefer briefing depending only on Node + contracts types. Databricks + weather + news are the required sections. Reminders are optional and not required for v1.

## Apps own wiring, packages own policy

| Concern | Lives in |
| --- | --- |
| Conversation FSM, interruption, prompt assembly | `packages/core` |
| STT/LLM/TTS HTTP/WS | `packages/provider-*` |
| PCM subscribe/publish, energy VAD | `packages/livekit` |
| JSONL retrieve/commit, persona load | `packages/memory` |
| Brief generate, prefs, Open-Meteo, RSS | `packages/briefing` |
| Register providers, env, LiveKit connect | `apps/voice-agent` |
| WebRTC mic, captions, composer | `apps/voice-client` |
| Prefs form (news sources, weather location) | a UI module next to briefing — not a hosted app shell |

## Naming

| Alfred | CORA |
| --- | --- |
| `@alfred/*` | `@cora/*` |
| `ALFRED_*` env | `CORA_*` env (provider keys stay `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, etc.) |
| `alfred-agent` / `alfred-client` | `cora-agent` / `cora-client` |
| `LIVEKIT_ROOM=alfred-dev` | `LIVEKIT_ROOM=cora-dev` |
| “Alfred” in UI copy | “CORA” |

## UI modules

Talk and Daily Brief preferences are **embeddable UI**. Do not add Graph, Graph (beta), Vector Explorer, Notes, Ingest, or Claim. Do not build Alfred’s iframe desktop shell unless the host asks for it later.
