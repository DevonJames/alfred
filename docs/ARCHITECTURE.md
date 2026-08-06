# ALFRED Conversation Core — Architecture

## Ownership

ALFRED Conversation Core owns the session:

- Conversation state and transitions
- Recent (short-term) conversation context
- Provider selection and sticky failover state
- Interruptions, addenda, backchannels, and resumptions
- Response delivery tracking (response ledger)
- Delegation to agent harnesses via a stable `delegate_task` abstraction
- Invocation of exactly one active long-term memory provider per profile

Adapters beneath the core (never the other way around):

- LLM / STT / TTS / unified realtime providers
- Memory products
- Agent harnesses (OpenClaw, Hermes, Codex, Claude, …)
- LiveKit (future media transport)
- Databases and UIs

LiveKit is a real-time media layer. It must not become the domain model. Conversation policy lives in `@alfred/core`.

## Package layout

```
packages/contracts     Provider-neutral Zod schemas and types
packages/core          FSM, ledgers, failover, prompt assembly, session orchestrator
packages/providers     Registry + fake (later real) speech/LLM adapters
packages/memory        Memory controller + fake/local providers
packages/agents        Harness router + stub adapters
packages/persistence   Repository interfaces + in-memory implementations
apps/simulator         Deterministic text-only CLI scenarios
```

Dependency rule: adapters and apps depend on `contracts` / `core`. Core depends on `contracts` and persistence interfaces. Vendor SDKs never appear in `contracts`.

## Pipeline modes

### Cascaded

Independent ordered priority lists for STT, LLM, and TTS. Components may fail over independently within their modality.

### Unified

One native realtime provider owns STT + LLM + TTS as a locked stack.

- Selecting unified locks individual STT/LLM/TTS selectors.
- Configuration API returns machine-readable lock reasons.
- Independent providers cannot be substituted inside a unified session.
- Switching any individual modality requires returning to cascaded mode.
- Unified failure fails over only to another compatible unified provider unless the user explicitly allows cascaded fallback.

## Conversation state machine

Explicit, inspectable FSM. Significant transitions emit structured domain events suitable for tracing and replay.

States include (non-exhaustive): Idle, Listening, UserSpeechDetected, Transcribing, UserTurnCommitted, RetrievingMemory, GeneratingResponse, SynthesizingSpeech, AssistantSpeaking, UserAddendumReceived, UserBackchannelReceived, GenuineInterruptionReceived, InterruptionArbitration, ResponseResumption, AgentTaskDelegated, WaitingForAgentResult, Failed, Recovering, Cancelled.

## Response ledger

A response is not one undifferentiated string. The ledger separately tracks:

| Bucket            | Meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| Proposed          | Text proposed by the LLM                                |
| Committed         | Text accepted as part of the assistant response         |
| SubmittedToTts    | Text sent to synthesis                                  |
| AudioBuffered     | Synthesized audio ready but not yet delivered           |
| Delivered         | Text/audio actually heard by the user                   |
| Unspoken          | Remainder not yet delivered                             |
| Abandoned         | Cancelled after interruption or supersession            |
| Resumed           | Previously unspoken content continued after arbitration |
| Addendum segments | Supplementary/corrective segments for late user speech  |

After an interruption, arbitration uses delivered vs unspoken to decide what to say next.

## Event ledger

Append-only structured events:

`eventId`, `sessionId`, `turnId`, `responseId?`, `providerId?`, `type`, `timestamp`, `sequence`, `correlationId`, `causationId`, `payload`.

## Sticky failover

Per-modality ordered priority lists:

1. Select first healthy provider.
2. Classify failures (timeout, connection, rate-limit, content, auth, …).
3. On qualifying failure, advance and **stay** (sticky).
4. Do not retry primary every request.
5. Return to primary only on: user request, retry-primary interval + successful health probe, or config change.

Configurable: connection / first-token / total timeouts, consecutive-failure threshold, cooldown, retry-primary interval, manual pin.

## Memory

- Short-term context: owned by the conversation core.
- Long-term memory: exactly one active provider per user profile.
- **Current default (voice):** `LocalFileMemoryProvider` (`memory.local`) — durable JSONL under `ALFRED_MEMORY_PATH` or `./data/memory/{profileId}.jsonl`. Stores `fact` / `turn` / `note` via provenance; heuristic fact extraction on user commits; keyword/token retrieve with facts preferred. Inspect/export/import via `pnpm memory`.
- **Persona bootstrap (OpenClaw-style):** always-injected markdown under `ALFRED_PERSONA_DIR` or `./data/persona/{profileId}/` — `SOUL.md` (tone/boundaries), `IDENTITY.md` (agent self-record), `USER.md` (user model directives). Seeded on first voice start; not retrieved via JSONL. Edit files on disk; `pnpm memory -- persona` to print.
- Mem0 / Letta / Graphiti / Zep and vector/ANN indexes are deferred.
- Normalized retrieve / commit / optional inspect-edit-delete / canonical JSONL import-export.
- Not assumed to be a vector database.

## Agency

Conversational LLM sees a stable `delegate_task` capability. The core routes by task category to a user-configured ordered harness list. Harness-specific tool schemas are not dumped into every prompt.

Codex is treated as coding / repository / filesystem / shell. Claude as agent SDK / computer-use via an app-supplied execution environment. OpenClaw via Gateway APIs (future). Hermes via headless JSON-RPC/WebSocket (future).

## Cancellation

`AbortSignal` plus typed reasons: user cancellation, interruption, provider timeout, provider failure, superseded generation, session termination, application shutdown. These are not interchangeable exceptions.

## Prompt assembly

Structured inputs, not indiscriminate concatenation:

- System instructions
- Persona bootstrap (`SOUL.md` → `IDENTITY.md` → `USER.md`)
- Current user turn
- Recent conversation context
- Retrieved long-term memory (JSONL facts/turns)
- Existing response state (spoken / unspoken)
- Late addenda
- Interruption state
- Agent results
- High-level capabilities

The assembler can instruct: addendum, continuation, correction, or replacement.

## Persistence

Repository interfaces for profiles, provider configs, priority lists, sessions, turns, response ledgers, events, memory settings, agent routing. M1 uses in-memory implementations. Postgres is the intended production store.

## Security

- No secrets in git
- `SecretRef` for credentials (env / encrypted stub / local stub)
- Permission scopes, action confirmations, audit events (stubbed where unimplemented)

## Observability

Domain events are the primary diagnostic surface. OTel-compatible hooks exist; M1 uses a no-op exporter.

## Voice path (M2)

```text
Client WebRTC
      │
      ▼
LiveKitRoomSession (@livekit/rtc-node)
      ├── AudioStream (remote mic → PCM 16 kHz)
      ├── EnergyVad → barge-in evidence
      └── AudioSource (assistant PCM 24 kHz publish)
      │
      ▼
LiveKitMediaBridge → VoiceSessionController
                           ├── Deepgram Flux (SttTurnEvent)
                           ├── OpenAI Responses (Terra)
                           └── ElevenLabs multi-context TTS
```

- `EagerEndOfTurn` → provisional LLM generation (not history commit)
- `TurnResumed` → supersede provisional; treat as continuation evidence
- `EndOfTurn` → commit user turn; speak via multi-context TTS
- Local energy VAD during assistant speech → immediate `stopPlayback` + clear outbound queue (arbiter still owns semantic interruption)

## LiveKit

`LiveKitRoomSession` joins the room, subscribes to remote audio, and publishes the assistant track. Conversation policy remains in `@alfred/core`. We intentionally use `@livekit/rtc-node` rather than LiveKit Agents' `AgentSession` voice pipeline so STT/LLM/TTS are not owned by LiveKit.
