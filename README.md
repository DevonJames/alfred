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
| `pnpm client`     | Local mic client with WebRTC AEC (`apps/voice-client`, port 5173) |
| `pnpm desktop`    | Local UI host — voice uplink, memory graph/ingest (port 3000) |
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
| 3 | `pnpm desktop` **or** `pnpm client` | **Desktop (preferred):** http://127.0.0.1:3000/voice/ — same uplink UI (waveform + captions), token minted by the desktop host. **Standalone:** http://localhost:5173 via `pnpm client`. Click **ENGAGE**, talk. |

Typical local loop: keep **terminal 2** (`pnpm voice`) and **terminal 3** (`pnpm desktop` or `pnpm client`) up. Use **terminal 1** when you want Meet/Playground instead of (or in addition to) the AEC client — paste the printed URL/token there. Prefer the desktop or Vite client for speakerphone testing; Meet does not guarantee AEC.

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

**Ingest a cross-AI knowledge export** (from ChatGPT / Claude / etc.):

```bash
# Preview split without writing
pnpm memory -- ingest-export ./path/to/export.md --dry-run

# Archive full file, merge High-Priority + How to Work into USER.md,
# import the rest as retrievable memory notes
pnpm memory -- ingest-export ./path/to/export.md
```

Flags: `--dry-run`, `--no-user`, `--no-memory`. Full copies land in `data/knowledge/exports/` (gitignored). Re-running replaces the previous `<!-- alfred:ingest-export:* -->` block in `USER.md`.

After multiple ingests, trim redundant USER.md lines:

```bash
pnpm memory -- dedupe-user --dry-run
pnpm memory -- dedupe-user

# Stronger: summarize always-on USER.md, strip junk/credentials, park detail in memory
pnpm memory -- cleanup-user --dry-run
pnpm memory -- cleanup-user
```

(`dedupe-user` only removes near-duplicates. `cleanup-user` rebuilds a compact profile under the inject budget and imports overflow notes. Both write a timestamped `USER.md.bak-*` backup.)

### X.com and YouTube Apple Notes ingest

Alfred can pull X.com posts, threads, and Articles, plus **YouTube videos**, from one or more Apple Notes inboxes (no X API, no YouTube/Google API). X capture uses a dedicated local Chrome/Brave profile (Playwright, with OpenAI Computer Use as fallback). YouTube capture uses **yt-dlp** on `PATH` (or `ALFRED_YTDLP_PATH`) for metadata and captions only — never audio or video. Each memory stores the **note name**, **X or YouTube as source**, **when the post/video was published**, and **when Alfred ingested it**, so later you can ask things like “the X article from my marketing note last week” or “that YouTube video from my marketing note.”

Successful URLs are removed from the inbox note and appended to `{Note} Ingested`. Failures stay in the inbox (optionally marked `— failed: paywall` or `— failed: no transcript`). Playlists and channel pages are not supported. New items that land today appear in the daily briefing; ingest invalidates that day’s briefing cache.

**Setup**

1. Install yt-dlp (required for YouTube links; no Google API):

```bash
brew install yt-dlp
```

2. Log the Alfred browser profile into X once (headed window). **Close that Chrome window** (and let `ingest-x-login` exit) before running ingest — Chrome only allows one process on this profile:

```bash
pnpm memory -- ingest-x-login
```

3. Register each Apple Note by folder + title (fails if the note cannot be found):

```bash
pnpm memory -- ingest-x-source add --folder "Alfred" --note "Marketing"
pnpm memory -- ingest-x-source list
```

4. Run ingest (first dump of dozens, then typically a few new links per day). Same URL pasted back into the inbox refreshes the existing memory:

```bash
pnpm memory -- ingest-x
pnpm memory -- ingest-x --note "Marketing"
pnpm memory -- ingest-x https://x.com/foo/status/123
pnpm memory -- ingest-x https://youtu.be/dQw4w9WgXcQ
```

Voice: “ingest my X notes” starts the batch in the background; “go pull this X link …” or “go pull this YouTube link …” fetches one URL and speaks the result. With `pnpm desktop` running, the same batch also runs on a schedule (`ALFRED_X_INGEST_SCHEDULE`, default `06:00` local). Optional env: `ALFRED_BROWSER_USER_DATA_DIR`, `ALFRED_BROWSER_CHANNEL` (`chrome` / `brave` / `chromium`), `ALFRED_X_CUA` (`fallback` / `always` / `off`), `ALFRED_YTDLP_PATH`. The Mac generally needs to be awake (and usually unlocked) for Notes scripting.

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
packages/memory                 Memory controller + fake/local/OIP providers + X ingest
packages/browser                Playwright + Computer Use capture (X pages, out of core)
packages/briefing               Daily briefing (including today’s X ingest)
packages/agents                 Agent router + harness stubs + X ingest harness
packages/persistence            Repository interfaces + in-memory implementations
apps/simulator                  M1 text-only scenario runner
apps/voice-agent                M2 cascaded voice runtime entrypoint
```

## Central rule

> Conversation is the primary runtime. Memory and agency are modular services invoked by the conversation runtime.

## Not claimed complete

Postgres persistence, OTel exporters, Scribe/Groq/Cartesia adapters, OpenAI GPT-Realtime unified mode, and vendor memory products (Mem0 etc.) are deferred. Local JSONL LTM is the current default. See the implementation plan.
