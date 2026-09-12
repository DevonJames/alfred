# Alfred docs

Index of `docs/`. Product code in this repo is the source of truth when a note and the tree disagree.

## Start here

| Doc | What it is |
| --- | --- |
| [../README.md](../README.md) | Setup, `make alfred`, desktop URLs, dual memory, commands |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Conversation Core, LiveKit-as-transport, dual memory, desktop/iOS |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | M1 / M2 / post-M2 shipped / M3 next |
| [DECISIONS.md](./DECISIONS.md) | ADRs |

## Product requirements

| Doc | What it is |
| --- | --- |
| [alfred-conversation-core-prd.md](./alfred-conversation-core-prd.md) | Session ownership, FSM, ledger, failover |
| [ALFRED-MEMORY-prd.md](./ALFRED-MEMORY-prd.md) | OIP-local packages as truth; indexes are disposable |
| [alfred-ios-prd.md](./alfred-ios-prd.md) | Phone as LiveKit + API client, not a second core |

## Desktop, iOS, connectivity

| Doc | What it is |
| --- | --- |
| [ios-desktop-pairing.md](./ios-desktop-pairing.md) | Claim → discover → PIN pair (implemented) |
| [ios-livekit-voice.md](./ios-livekit-voice.md) | Talk / LiveKit protocol (implemented) |
| [accountless-alfrd-net.md](./accountless-alfrd-net.md) | Link JWT, no email/password account |
| [alfrd-net-desktop-handoff.md](./alfrd-net-desktop-handoff.md) | Desktop registration + relay |

## Memory and ingest

| Doc | What it is |
| --- | --- |
| [embedding-space.md](./embedding-space.md) | Graph (beta) Semantic Map + Vector Explorer |
| [local-embeddings-mac-mini.md](./local-embeddings-mac-mini.md) | Follow-up: offline embedder, swap the embed step only |
| [audio-notes.md](./audio-notes.md) | Voice notes pipeline and `/notes` / `/api/notes` |
| [multi-desktop-memory-sync.md](./multi-desktop-memory-sync.md) | Offline `.alfred-memory.zip` merge; live sync is future |
| [knowledge-export-prompt.md](./knowledge-export-prompt.md) | Cross-AI export ingest prompt |
| [DAILY-BRIEFING-STAGE-2.md](./DAILY-BRIEFING-STAGE-2.md) | Planned briefing sections (Stage 1 already ships) |

## Robot / experimental

| Doc | What it is |
| --- | --- |
| [gpt-live.md](./gpt-live.md) | Experimental GPT-Live voice (`pnpm voice:live` / `make alfred VOICE=live`) |
| [expressive-mode-robot.md](./expressive-mode-robot.md) | Weekend note: LiveKit Expressive Mode → face + head for alfred-robot |
