Build ALFRED Conversation Core as an independent provider-neutral service.

It must own conversation state, recent context, provider selection, failover state, interruptions, response delivery, and delegation. OpenClaw, Hermes, Codex, Claude, memory systems, model providers, and speech providers are adapters beneath it.

Use LiveKit for WebRTC media transport, microphone and speaker streaming, turn detection, VAD integration, and adaptive interruption detection. Implement the authoritative conversational state machine in TypeScript rather than delegating conversation policy to LiveKit or an agent harness.

Support two voice modes:

1. Cascaded: STT → LLM → TTS.
2. Unified: one native speech-to-speech provider owning STT, LLM, and TTS.

When a unified provider is selected, lock all three component selectors together. The user must switch back to cascaded mode before independently changing STT, LLM, or TTS.

Each modality must have a user-controlled ordered priority list. On provider failure, advance to the next provider and remain there until the user requests a primary check or the configured retry-primary period expires and the primary passes a health probe.

Maintain a response ledger that separately records generated text, committed text, text submitted to TTS, buffered audio, text actually spoken, unspoken text, and cancelled text.

When the user speaks while an answer is still being generated but no assistant audio is playing, continue the original answer. Transcribe the new speech as a late addendum and generate an additional response segment that does not repeat the first answer.

When the user speaks while assistant audio is playing, distinguish backchanneling from a genuine interruption. Stop audio for a genuine interruption, preserve exactly what the user heard, and run an interruption arbiter that chooses whether to finish the interrupted thought, abandon it, or respond directly to the new input.

Keep short-term conversation memory inside ALFRED Conversation Core. Permit exactly one active long-term memory provider per profile. Require every memory adapter to support normalized retrieval and turn commits, with canonical JSONL import and export to prevent provider lock-in.

Expose one stable `delegate_task` capability to the conversational LLM. Route the task to OpenClaw, Hermes, Codex, Claude, or another installed harness according to user-configured task categories and priority lists. Do not expose every harness-specific tool schema in every conversational prompt.

Treat Codex primarily as a coding, repository, filesystem, and shell harness. Treat Claude as an Agent SDK or computer-use harness operating through an execution environment supplied by the application. Integrate OpenClaw through its Gateway agent APIs and Hermes through its headless JSON-RPC/WebSocket server.

Start by building the provider contracts and a text-only state-machine simulator with fake providers. Test every overlap, interruption, failure, recovery, and failover transition before connecting production voice providers.
