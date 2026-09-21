# CORA tech

## Runtime

- Node.js **22+** on Windows 10/11
- pnpm **9+** workspaces (no Turborepo until it hurts)
- TypeScript strict, `module`/`moduleResolution` `NodeNext`, `ES2022`
- Vitest for unit tests
- Zod in `@cora/contracts` only for domain schemas — vendor SDK types stay in adapters
- `tsx` to run the voice runtime and simulator in development

Do not use GNU Make as the primary start path. Alfred’s `Makefile` has Darwin Apple-STT hooks.

**Do not implement a product HTTP host, login, pairing, or session-token API.** Those belong to the host application, which is specified elsewhere. This pack delivers libraries, a voice runtime, UI modules, and a text-turn API on `SessionOrchestrator`.

## Locked v1 voice stack (cascaded)

| Role | Provider | Notes |
| --- | --- | --- |
| STT | Deepgram Flux | `flux-general-en`, `eagerEotThreshold: 0.4`. **Required on Windows.** |
| LLM | OpenAI Responses | Conversational preset (Alfred: `gpt-5.6-terra`, reasoning none). Fail over to xAI Grok when `GROK_API_KEY` / `XAI_API_KEY` is set. |
| TTS | ElevenLabs Flash | `eleven_flash_v2_5`, PCM 24 kHz, multi-context WebSocket. Voice id via `ELEVENLABS_VOICE_ID`. |
| Media | LiveKit | Transport + energy VAD barge-in evidence only. Conversation policy stays in `@cora/core`. |

There is **no** Apple on-device STT package. If `DEEPGRAM_API_KEY` is missing, the voice process must refuse to start with a clear error — do not silently degrade to a fake STT in production wiring.

Do not ship the experimental GPT-Live / LiveKit Agents `AgentSession` path in v1.

## Central rule (from Alfred ADR)

> Conversation is the primary runtime. Memory and agency are modular services invoked by the conversation runtime.

LiveKit must not become the domain model. Use `@livekit/rtc-node` in the voice runtime and `livekit-client` in the Talk UI module. Do not use LiveKit Agents’ voice pipeline for the cascaded stack.

Minting LiveKit join tokens is a **host** concern. `@cora/livekit` may export a helper equivalent to Alfred’s `createLiveKitToken` for the host to call; do not add a public token HTTP route or a login/pairing flow around it.

## Windows constraints

- Always `path.join` / `path.resolve`. Never hardcode `/`.
- Data dirs default under the repo: `data/memory`, `data/persona`, `data/briefing` (overridable by env).
- Native addons: `@livekit/rtc-node` ships Windows binaries. Do not add Swift, Darwin-only, or Homebrew steps.

## Secrets

Never commit `.env`. Use `SecretRef` (`env` | stub). Required for the cascaded voice runtime:

```
DEEPGRAM_API_KEY
OPENAI_API_KEY
ELEVENLABS_API_KEY
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
```

Optional: `GROK_API_KEY` / `XAI_API_KEY`, `ELEVENLABS_VOICE_ID`, briefing location env vars.

Weather (Open-Meteo) and RSS news need **no API keys**.

Do not add user-account, OAuth, PIN, device-bearer, or identity-file env vars from Alfred.

## Persistence (v1)

In-memory repositories for session/FSM/ledgers (same as Alfred M1/M2). Durable state is files:

| Store | Path |
| --- | --- |
| JSONL memory | `data/memory/{profileId}.jsonl` |
| Persona | `data/persona/{profileId}/SOUL.md`, `IDENTITY.md`, `USER.md` |
| Briefing prefs | `data/briefing/{profileId}/prefs.json` |
| Briefing offer state | `data/briefing/{profileId}/state.json` |
| Briefing cache | `data/briefing/{profileId}/cache-YYYY-MM-DD.json` |

Postgres is deferred. Profile identity (`CORA_PROFILE_ID`) is a local string the host may set — not a login system.
