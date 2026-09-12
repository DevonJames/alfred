# ALFRED Conversation Core — Implementation Plan

## Central rule

Conversation is the primary runtime. Memory and agency are modular services invoked by the conversation runtime. OpenClaw, Hermes, Codex, Claude, memory systems, model providers, and speech systems are adapters beneath it.

## Milestones overview

| Milestone            | Goal                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| **M1**               | Text-only conversation-core simulator with fake providers                        |
| **M2**               | Cascaded voice: Deepgram Flux → OpenAI Terra → ElevenLabs Flash + LiveKit bridge |
| **Post-M2 (shipped)** | Desktop host, iOS Talk, OIP-local memory, ingest, briefing, notes, Graph / embeddings |
| **M3**               | Unified realtime providers, Postgres persistence, OTel exporters                 |
| **M4**               | Vendor memory adapters (Mem0 etc.) and real agent harness wiring                 |

---

## Milestone 1 — Required

- Provider-neutral Zod contracts and TypeScript types
- Hand-rolled conversation state machine with structured events
- Response ledger (proposed / committed / TTS / buffered / delivered / unspoken / abandoned / resumed)
- Late-addendum-while-generating behavior
- Interruption arbitration with backchannel placeholder
- Sticky provider failover controller
- Cascaded vs unified pipeline validation and locking
- Memory controller (one active LTM provider) with fake + local providers
- Agent harness router with stub OpenClaw / Hermes / Codex / Claude adapters
- Repository interfaces + in-memory persistence
- CLI simulator with 15 deterministic scenarios
- Automated Vitest coverage for critical paths
- Root README, `.env.example`, Docker Compose (Postgres scaffold)

## Milestone 1 — Scaffolded for later

- PostgreSQL-compatible repository interfaces (in-memory only at runtime)
- Docker Compose Postgres service (not required to run simulator)
- OpenTelemetry-compatible event/span hooks (no-op exporter)
- `SecretRef` abstraction (`env` | `encrypted` | `localStub`)
- LiveKit described as future media adapter boundary in architecture docs
- Agent harness stubs with real capability manifests (no real Gateway/RPC)

## Milestone 1 — Intentionally deferred

- LiveKit WebRTC / VAD / turn detection wiring — **done in M2**
- Real LLM, STT, TTS APIs — **done in M2** (unified speech-to-speech still deferred)
- Mem0, Letta, Graphiti, Zep, and other production memory products (voice path still defaults to JSONL; product store is OIP-local)
- Real OpenClaw Gateway, Hermes JSON-RPC, Codex CLI, Claude Agent SDK integrations
- HTTP API, UI, authentication product surface — **done post-M2** (`apps/desktop-client`, `apps/iOS-client`)
- Robot control, embodiment, sensors, navigation, hardware
- Kubernetes, microservices, Kafka, and similar infrastructure

---

## Assumptions (PRD left details open)

1. Node 22+, TypeScript strict, pnpm workspaces, Vitest, Zod. Turborepo skipped for M1.
2. Hand-rolled FSM (not XState) for inspectability.
3. Speech delivery in the simulator is timed text chunks on an injectable clock.
4. Interruption arbiter is rule-based and scriptable for tests.
5. Backchannel classification is a placeholder interface driven by scenario scripts.
6. Secrets are never committed; unsupported mechanisms are stubbed clearly.

See [DECISIONS.md](./DECISIONS.md) for ADR-style rationale.

---

## Milestone 2 — Cascaded voice stack (shipped)

**Locked providers**

| Role  | Provider         | Model / notes                                                                   |
| ----- | ---------------- | ------------------------------------------------------------------------------- |
| STT   | Deepgram Flux    | `flux-general-en`, `eagerEotThreshold: 0.4`                                     |
| LLM   | OpenAI Responses | `gpt-5.6-terra`, `reasoning.effort=none` (Conversational default)               |
| TTS   | ElevenLabs       | `eleven_flash_v2_5`, voice `qXcNpxDCD6dKvASibF0r`, multi-context WS, PCM 24 kHz |
| Media | LiveKit          | Transport + VAD barge-in evidence only                                          |

**Required in M2**

- Streaming STT / multi-context TTS / LLM preset contracts
- `VoiceSessionController` (EagerEOT provisional gen, TurnResumed, EndOfTurn commit)
- Sentence-aware TTS chunker + latency marks
- `@alfred/provider-deepgram`, `@alfred/provider-openai`, `@alfred/provider-elevenlabs`
- `@alfred/livekit` room session (subscribe mic / publish assistant) + `apps/voice-agent`
- Keep M1 `pnpm simulate` / unit tests green

**Local LTM (shipped with voice path)**

- `LocalFileMemoryProvider` is the default active memory for `pnpm voice` (`ALFRED_MEMORY_PROVIDER_ID=memory.local`)
- Atomic JSONL persist; fact + episodic turn kinds; heuristic extraction (name / preference / “remember that…”)
- OpenClaw-style `SOUL.md` / `IDENTITY.md` / `USER.md` under `data/persona/{profileId}/` — always injected; CLI `pnpm memory -- persona`
- CLI: `pnpm memory -- inspect|persona|export|import`
- Verify across restarts: say “My name is …”, stop voice, restart, ask “What’s my name?”

**Deferred from earlier M2 sketch**

- Postgres persistence (still in-memory for session/ledgers)
- Production OTel exporters (domain `latency.mark` events exist)
- Real Scribe / Groq / Cartesia / local adapters (priority IDs scaffolded only)
- OpenAI GPT-Realtime unified adapter → M3
- Mem0 and other vendor memory adapters → M4

## Post-M2 — Product host (shipped)

Not a numbered Conversation Core milestone; these landed on top of M2 and are in the tree today.

- `apps/desktop-client` on port 3000: Talk (`/voice/`), Brief, Notes, Graph, Graph (beta), Vector Explorer, ingest, claim/pair
- `apps/iOS-client`: alfrd.net link + PIN pair, LiveKit Talk (hold / continuous / chat), CallKit for backgrounded continuous, notes + memory APIs
- `memory.oip-local` as canonical store for desktop HTTP / iOS; JSONL remains the voice-agent default
- Ingest: knowledge export, PDF, photo (Grok/OpenAI), markdown folders, X / YouTube from Apple Notes, audio notes, `.alfred-memory.zip` merge
- Daily briefing Stage 1 (`@alfred/briefing`, `/briefing`, voice soft offer)
- Graph (beta) embedding space: OpenAI embeddings + `FileVectorIndex` + MDS/PCA Semantic Map ([embedding-space.md](./embedding-space.md))
- LiveKit transport hygiene: reconnect + TTS buffer/republish; iOS 90s hold-idle leave; browser Start/Stop race guard

## Milestone 3 — Recommended next

1. OpenAI GPT-Realtime unified adapter behind `UnifiedRealtimeProvider`
2. Postgres implementations of repository interfaces
3. OTel exporters for FSM + provider spans
4. Optional multilingual STT primary (ElevenLabs Scribe) for non-English profiles
5. Local / offline embeddings (swap embed step only — [local-embeddings-mac-mini.md](./local-embeddings-mac-mini.md))
6. Live desktop↔desktop OIP sync (offline bundle merge already ships — [multi-desktop-memory-sync.md](./multi-desktop-memory-sync.md))
7. Daily briefing Stage 2 ([DAILY-BRIEFING-STAGE-2.md](./DAILY-BRIEFING-STAGE-2.md))
