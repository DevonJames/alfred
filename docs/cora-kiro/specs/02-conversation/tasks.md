# Tasks: Conversation

- [ ] 1. Port `@cora/provider-deepgram`, `@cora/provider-openai`, `@cora/provider-xai`, `@cora/provider-elevenlabs` from Alfred adapters (no Apple STT package)
  - _Requirements: 2.1, 2.2, 6.2_
- [ ] 2. Port `@cora/livekit` room session, media bridge, EnergyVad, PCM helpers; export `createLiveKitToken` as a **library** function only
  - _Requirements: 2.2, 2.8, 3.1_
- [ ] 3. Complete `VoiceSessionController`: Flux EagerEOT / TurnResumed / EndOfTurn, TTS chunker, echo filter, self-voice gate, interruption arbiter, weather + briefing ports
  - _Requirements: 2.3–2.7, 4.1–4.4, 5.1–5.4_
- [ ] 4. Wire `apps/voice-agent` cascaded runtime (JSONL memory + persona + briefing + weather). Fail if Deepgram key missing. No `darwin` STT branch. Identities `cora-agent` / room `cora-dev`.
  - _Requirements: 2.1, 2.2, 6.1–6.3_
- [ ] 5. Port Talk UI module from `apps/voice-client` (waveform, captions, composer, mute, connect race guard). Host injects `{ url, token, room, identity }`.
  - _Requirements: 3.1–3.5_
- [ ] 6. Export a `runTextTurn` (or equivalent) that uses `SessionOrchestrator` + real LLMs when keyed; no HTTP route
  - _Requirements: 1.1–1.4_
- [ ] 7. Port weather-intent tests; add a voice-session test that briefing `play` speech bypasses LLM invention
  - _Requirements: 4.4, 5.1_
- [ ] 8. Verify packages do not include GPT-Live worker, Apple STT, lights, robot, token HTTP, or pairing
  - _Requirements: 1.4, 6.1–6.3_
