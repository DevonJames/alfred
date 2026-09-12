# ALFRED Conversation Core — Decision Log

## ADR-001: pnpm workspaces without Turborepo (M1)

**Status:** Accepted  
**Context:** Greenfield monorepo with a small number of packages.  
**Decision:** Use pnpm workspaces and root scripts. Skip Turborepo until build caching across many packages becomes a bottleneck.  
**Consequences:** Simpler M1 toolchain; can add Turbo later without redesigning packages.

## ADR-002: Hand-rolled state machine

**Status:** Accepted  
**Context:** Need an inspectable FSM with structured transition events; avoid leaking conversation policy into a framework.  
**Decision:** Implement a typed transition table and event emitter in `@alfred/core` rather than XState.  
**Consequences:** Full control over states/events; tests assert transitions directly; no XState learning curve for contributors.

## ADR-003: Timed text chunks for speech simulation

**Status:** Accepted  
**Context:** M1 must prove interruption and delivery ledger behavior without real audio.  
**Decision:** Model TTS delivery as deterministic timed text chunks driven by an injectable `Clock`.  
**Consequences:** Tests use fake timers; no flaky wall-clock audio tests.

## ADR-004: Scriptable interruption arbiter

**Status:** Accepted  
**Context:** PRD requires multiple arbitration outcomes; acoustic classification is future work.  
**Decision:** Provide an `InterruptionArbiter` interface with a default rule-based implementation and scenario-injectable decisions.  
**Consequences:** Deterministic tests for abandon / finish-sentence / resume / backchannel / clarify.

## ADR-005: Placeholder backchannel classifier

**Status:** Accepted  
**Context:** Not every short utterance is an interruption; real acoustic/semantic classification is deferred.  
**Decision:** `BackchannelClassifier` interface with a fake classifier driven by scenario metadata.  
**Consequences:** Contract ready for LiveKit/VAD integration later; M1 behavior is scripted.

## ADR-006: Vendor-free contracts package

**Status:** Accepted  
**Context:** Provider-neutral runtime is a product requirement.  
**Decision:** `@alfred/contracts` contains only Alfred domain types and Zod schemas. Vendor objects stay inside adapters.  
**Consequences:** Adapters translate at the boundary; core never imports OpenAI/Anthropic/LiveKit/Mem0/OpenClaw SDKs.

## ADR-007: In-memory persistence for M1

**Status:** Accepted  
**Context:** Need repository boundaries without shipping production schema work.  
**Decision:** Define Postgres-oriented repository interfaces; implement in-memory stores; scaffold Docker Compose Postgres.  
**Consequences:** Simulator runs without Docker; swapping to Postgres is a later milestone.

## ADR-008: SecretRef stubs

**Status:** Accepted  
**Context:** Credentials must not be committed; full secret management is out of scope.  
**Decision:** `SecretRef` discriminated union (`env` | `encrypted` | `localStub`). Encrypted/local paths are stubs that throw or return clear “not implemented” errors unless used in tests with stub values.  
**Consequences:** Honest incompleteness; no fake security.

## ADR-009: Codex and Claude harness roles

**Status:** Accepted  
**Context:** PRD assigns different roles to harnesses.  
**Decision:** Codex manifest: coding, repository, filesystem, shell. Claude manifest: general computer use, browser, research (via app-supplied environment). OpenClaw/Hermes: broad computer-use and messaging categories as stubs.  
**Consequences:** Routing tests encode these capability boundaries before real integrations exist.

## ADR-010: Cancellation is typed

**Status:** Accepted  
**Context:** Treating all aborts as identical exceptions loses product meaning.  
**Decision:** Pair `AbortSignal` with `CancellationReason` enum and surface reason on ledger/events.  
**Consequences:** Downstream logic can distinguish interruption vs timeout vs superseded generation.

## ADR-011: Flux events are evidence, not policy

**Status:** Accepted  
**Context:** Deepgram Flux emits EagerEndOfTurn / TurnResumed / EndOfTurn.  
**Decision:** Map Flux events to Alfred `SttTurnEvent` and handle them in `VoiceSessionController`. LiveKit/Flux must not own the conversation FSM. EagerEOT starts provisional generation without committing history; EndOfTurn commits.  
**Consequences:** Speculative latency overlap without corrupting turn history on resumed speech.

## ADR-012: Default LLM is GPT-5.6 Terra (Conversational)

**Status:** Accepted  
**Context:** Need balance of judgment (addenda, interruptions, delegation) vs latency.  
**Decision:** Default preset `conversational` → `gpt-5.6-terra` + `reasoning.effort=none`. Also expose `instant` (Luna) and `deliberate` (Terra + low). Mapping lives only in `@alfred/provider-openai`.  
**Consequences:** Core stays vendor-neutral; operators can change preset without changing contracts.

## ADR-013: ElevenLabs multi-context TTS

**Status:** Accepted  
**Context:** Interruptions and addenda need independent synthesis contexts.  
**Decision:** Primary TTS is ElevenLabs Flash v2.5 over multi-context WebSocket with PCM 24 kHz and alignment → response ledger. Cartesia/others remain priority stubs.  
**Consequences:** Context A/B/C/D map to primary/addendum/replacement/resumption segments.

## ADR-014: LiveKit is transport only

**Status:** Accepted  
**Context:** LiveKit Agents can host full agent graphs; ALFRED must not surrender policy.  
**Decision:** `@alfred/livekit` exposes `LiveKitMediaBridge` (PCM in/out, VAD signals). Conversation policy remains in `@alfred/core`.  
**Consequences:** Sticky failover, ledger, and arbitration stay inspectable and provider-replaceable.

## ADR-015: Dual memory providers

**Status:** Accepted  
**Context:** Voice needed durable LTM early (JSONL). Desktop/iOS later needed typed OIP packages, artifacts, graph, and rebuildable indexes.  
**Decision:** Keep `memory.local` as the **voice-agent default** (`ALFRED_MEMORY_PROVIDER_ID`). Desktop HTTP, ingest, Graph, Notes, and iOS always use `memory.oip-local`. Reminders/briefing read OIP regardless of the voice active provider.  
**Consequences:** Two on-disk corpora until voice is pointed at OIP. Do not assume `/api/memory` and `pnpm voice` retrieve from the same store unless `ALFRED_MEMORY_PROVIDER_ID=memory.oip-local`.

## ADR-016: Embeddings are a rebuildable index

**Status:** Accepted  
**Context:** Graph (beta) needs a neighborhood view; Talk retrieval still uses FTS/graph, not ANN.  
**Decision:** Store OpenAI embeddings + a cached PCA projection in `{oipRoot}/indexes/vectors/` via `FileVectorIndex`. Semantic Map (MDS/PCA) projects on demand; original-space cosine is authoritative. Categories/types are for reveal and metrics only.  
**Consequences:** Deleting `indexes/vectors/` loses no memory. Local embedders can replace the OpenAI call without changing store, routes, or UI. Hybrid retrieval in Talk is deferred.

## ADR-017: Leave idle LiveKit peers; republish after reconnect

**Status:** Accepted  
**Context:** Muted iOS/desktop participants parked in the SFU until tab blur, stacking `alfred-ios-*` / `alfred-client` identities. Native reconnect often left a live local AudioSource whose packets never reached remotes.  
**Decision:** iOS hold-to-talk disconnects after 90s with mic off; chat, continuous Stop, and CallKit End leave immediately. Browser Talk uses a connect/disconnect state machine and `pagehide` leave. Agent buffers TTS during SFU outage and force-republishes the assistant track on recovery.  
**Consequences:** Hold-to-talk may drop before a long reply finishes if the user stays muted past 90s; reconnect audio is an implementation concern in `@alfred/livekit`, not Conversation Core policy.
