# Design: Conversation

## Overview

Port Alfred M2 cascaded voice and M1 text orchestrator. Media = LiveKit. Policy = `@cora/core`. Host owns serving the Talk UI and minting join tokens.

## Text path

```text
host calls SessionOrchestrator.submitUserTurn(text)
        → MemoryController.retrieve
        → PromptAssembler
        → LLM stream (OpenAI, Grok failover)
        → commit assistant turn + memory
        → return delivered text
```

Do not wrap this in Hono. Optional: a thin function `runTextTurn(text, sessionKey)` in `apps/voice-agent` or `packages/core` for the host.

LLM wiring (same as Alfred desktop text path, minus HTTP): OpenAI Responses if `OPENAI_API_KEY`, else/plus Grok, else fake in tests.

## Voice path

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
                           ├── Deepgram Flux
                           ├── OpenAI Responses (Grok failover)
                           └── ElevenLabs multi-context TTS
```

Reference: Alfred `docs/ARCHITECTURE.md` Voice path (M2), `packages/core/src/voice-session.ts`, `apps/voice-agent/src/wiring.ts` (delete Darwin Apple STT).

## Talk UI

Port `apps/voice-client` behaviors: Room connect, remote audio attach, waveform, captions, composer, mute, Start/Stop race guard. Identity `cora-client`.

**Input from host:** LiveKit URL + JWT + room name. Do not implement `GET /api/token`.

`@cora/livekit` may export `createLiveKitToken` for the host’s backend to call.

## Weather and briefing ports

`VoiceSessionController` accepts:

- `weather: WeatherForecastPort` → `lookupWeatherForecastSpeech`
- `briefing: BriefingVoicePort` → `handleUserTurn`

Implement weather in spec 04’s `@cora/briefing` but wire the port here once the package exists; until then, a stub port is acceptable if conversation tests do not require live weather.

## Echo / interruption

Port `echo-filter.ts`, `self-voice.ts`, `interruption.ts`, `tts-chunker.ts`. Do not port studio-lights or X-ingest intent files.

## Testing

- Weather intent unit tests (`packages/core/src/weather-intent.test.ts`).
- Voice-session tests with fakes for interruption and briefing decisions.
- No requirement to run live Deepgram in CI (`CORA_LIVE_VOICE_TESTS` off by default).
