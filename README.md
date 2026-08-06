# ALFRED Conversation Core

Provider-neutral conversational runtime. Conversation owns the session; memory and agency are modular services beneath it.

**Milestone 1:** text-only simulator with fake providers.  
**Milestone 2:** cascaded production voice stack adapters + LiveKit media bridge.

## Requirements

- Node.js 22+
- [pnpm](https://pnpm.io/) 9+

## Setup

```bash
pnpm install
cp .env.example .env
```

## Commands

| Command          | Description                                       |
| ---------------- | ------------------------------------------------- |
| `pnpm test`      | Run Vitest unit and scenario tests                |
| `pnpm simulate`  | Run the 15 M1 CLI scenarios                       |
| `pnpm voice`     | Start cascaded voice runtime (`apps/voice-agent`) |
| `pnpm client`     | Local mic client with WebRTC AEC (`apps/voice-client`) |
| `pnpm mint-token` | Print a LiveKit join token (Meet / Playground)         |
| `pnpm memory`     | Inspect / export / import local long-term memory       |
| `pnpm typecheck` | TypeScript check across packages                  |
| `pnpm format`    | Format with Prettier                              |
| `pnpm build`     | Emit `dist/` for each package                     |

Optional Postgres scaffold (not required for M1/M2 voice path):

```bash
docker compose up -d
```

## Milestone 2 cascaded voice stack

```text
Deepgram Flux (flux-general-en)
  → OpenAI GPT-5.6 Terra (Responses, reasoning none)
  → ElevenLabs Flash v2.5 (multi-context, pcm_24000, voice qXcNpxDCD6dKvASibF0r)
Media: LiveKit transport via @alfred/livekit (policy stays in @alfred/core)
```

Prereqs in `.env`: `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

**Three terminals** (from the repo root):

| Terminal | Command | What it does |
| -------- | ------- | ------------ |
| 1 | `pnpm mint-token` | Prints `{ url, room, identity, token }` for joining LiveKit Meet / Agents Playground (or for inspecting creds). One-shot; re-run when you need a fresh token. |
| 2 | `pnpm voice` | Starts the cascaded voice agent. Joins `LIVEKIT_ROOM` as `alfred-agent`, listens on remote mic PCM, runs STT→LLM→TTS, publishes assistant audio. Leave this running. |
| 3 | `pnpm client` | Starts the local mic client at http://localhost:5173 with WebRTC `echoCancellation` on. Open that URL, click **Connect** (it mints its own join token from `.env`), enable the mic, and talk. Leave this running. |

Typical local loop: keep **terminal 2** (`pnpm voice`) and **terminal 3** (`pnpm client`) up. Use **terminal 1** when you want Meet/Playground instead of (or in addition to) the AEC client — paste the printed URL/token there. Prefer `pnpm client` for speakerphone testing; Meet does not guarantee AEC.

> **Note:** Do not run `pnpm token` / `pnpm --filter … token` — `token` is a built-in pnpm CLI command (npm auth). Use `pnpm mint-token` (or `pnpm --filter @alfred/voice-agent run mint-token`).

Echo stack (layered):

```text
browser AEC → agent SelfVoiceGate (mic ≈ TTS PCM) → transcript echo-filter
```

Media path (policy stays in `@alfred/core`):

```text
remote mic → AudioStream → LiveKitMediaBridge → VoiceSessionController
assistant TTS PCM → AudioSource → published track → client
```

### Local durable memory + persona files

Voice defaults to `memory.local` (JSONL on disk). Path: `ALFRED_MEMORY_PATH` or `./data/memory/{ALFRED_PROFILE_ID}.jsonl` (gitignored).

OpenClaw-style persona bootstrap (always injected into the system prompt, separate from retrieved JSONL):

| File | Role |
| ---- | ---- |
| `SOUL.md` | Persona, tone, boundaries |
| `IDENTITY.md` | Agent name / vibe / self-record |
| `USER.md` | Stable user model directives |

Default dir: `ALFRED_PERSONA_DIR` or `./data/persona/{ALFRED_PROFILE_ID}/` (seeded on first `pnpm voice`).

```bash
pnpm memory -- inspect
pnpm memory -- persona
pnpm memory -- export ./backup.jsonl
pnpm memory -- import ./backup.jsonl
```

**Live recall check:** with `pnpm voice` running, say “My name is Devon.” After the reply, stop the agent, start `pnpm voice` again, and ask “What’s my name?” — it should recall from the JSONL file. Confirm startup logs show `Memory: memory.local path=...` and `Persona: .../SOUL=yes`.

## Documentation

- [Product requirements](docs/alfred-conversation-core-prd.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Decision log](docs/DECISIONS.md)

## Monorepo layout

```
packages/contracts              Shared Zod schemas and provider-neutral types
packages/core                   FSM, ledgers, voice session, TTS chunker, failover
packages/providers              Registry + fake adapters (M1 simulator)
packages/provider-deepgram      Deepgram Flux STT
packages/provider-openai        OpenAI Responses LLM (Terra/Luna presets)
packages/provider-elevenlabs    ElevenLabs Flash multi-context TTS
packages/livekit                Room session + media bridge (transport only)
packages/memory                 Memory controller + fake/local providers
packages/agents                 Agent router + harness stubs
packages/persistence            Repository interfaces + in-memory implementations
apps/simulator                  M1 text-only scenario runner
apps/voice-agent                M2 cascaded voice runtime entrypoint
```

## Central rule

> Conversation is the primary runtime. Memory and agency are modular services invoked by the conversation runtime.

## Not claimed complete

Postgres persistence, OTel exporters, Scribe/Groq/Cartesia adapters, OpenAI GPT-Realtime unified mode, and vendor memory products (Mem0 etc.) are deferred. Local JSONL LTM is the current default. See the implementation plan.
