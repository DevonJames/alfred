# Requirements: Conversation (voice and chat)

**Feature:** Cascaded voice + text conversation with CORA  
**Depends on:** `01-platform-bootstrap`

## Introduction

Users speak or type to CORA. Conversation Core owns policy. LiveKit is media transport only. The host application (out of scope) supplies how the Talk UI is served and how a LiveKit join token is obtained.

## Requirements

### Requirement 1: Text conversation

**User Story:** As a user, I want to type to CORA and get a reply that uses persona and memory.

#### Acceptance Criteria

1. WHEN a text utterance is submitted to `SessionOrchestrator`, THE SYSTEM SHALL retrieve long-term memory, assemble the prompt (persona → user turn → recent context → memory), generate via the LLM priority list, and return delivered assistant text.
2. WHEN the LLM primary fails with a failover-eligible error, THE SYSTEM SHALL advance to the next LLM (Grok if keyed) and stay sticky.
3. WHEN no live LLM key is configured in tests, THE SYSTEM SHALL use the fake LLM.
4. THE SYSTEM SHALL NOT expose this as a hosted HTTP `POST /api/conversation/turn`. Export the orchestrator for the host to call.

### Requirement 2: Cascaded voice session

**User Story:** As a user, I want to talk to CORA over a microphone and hear the reply.

#### Acceptance Criteria

1. WHEN the voice runtime starts, THE SYSTEM SHALL require `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, and LiveKit credentials; missing Deepgram SHALL fail startup (no Apple STT, no silent fake STT in production).
2. WHEN a client publishes mic audio into the LiveKit room, THE SYSTEM SHALL subscribe PCM, run Deepgram Flux (`flux-general-en`, `eagerEotThreshold: 0.4`), generate with the LLM, synthesize with ElevenLabs Flash (`eleven_flash_v2_5`, PCM 24 kHz), and publish assistant audio.
3. WHEN Flux emits `EagerEndOfTurn`, THE SYSTEM SHALL start provisional LLM generation without committing history.
4. WHEN Flux emits `TurnResumed`, THE SYSTEM SHALL supersede the provisional generation.
5. WHEN Flux emits `EndOfTurn`, THE SYSTEM SHALL commit the user turn and speak via multi-context TTS.
6. WHEN local energy VAD detects barge-in during assistant speech, THE SYSTEM SHALL stop playback immediately; the interruption arbiter SHALL own semantic outcome.
7. THE SYSTEM SHALL run an echo stack: client AEC + agent self-voice gate (mic ≈ TTS PCM) + transcript echo-filter.
8. LiveKit SHALL NOT own the conversation FSM.

### Requirement 3: Talk UI module

**User Story:** As a user, I want a Talk surface with waveform, captions, mute, and a typed composer in the same session.

#### Acceptance Criteria

1. THE Talk UI SHALL connect to LiveKit with `{ url, token, room, identity }` supplied by the host (no token-mint UI, no login).
2. THE Talk UI SHALL show a live waveform, assistant captions, and user transcript.
3. THE Talk UI SHALL allow mic mute without ending the session and a composer to send text into the same conversation.
4. THE Talk UI SHALL prevent connect/disconnect races from leaving orphaned client participants (Alfred `sessionOp` state machine pattern).
5. Default identities: agent `cora-agent`, browser client `cora-client`. Room default `cora-dev`.

### Requirement 4: Weather in conversation

**User Story:** As a user, I want to ask “what’s the weather” without inventing numbers.

#### Acceptance Criteria

1. WHEN the user asks for weather without a place, THE SYSTEM SHALL call `get_weather_forecast` with no location (home zip/lat-lon).
2. WHEN the user names a city or zip, THE SYSTEM SHALL pass that location to the same Open-Meteo path used by the Daily Brief.
3. WHEN home location is unset and no place was named, THE SYSTEM SHALL say location is not configured rather than inventing a forecast.
4. THE SYSTEM SHALL parse casual weather utterances in Core (`looksLikeWeatherTask` / `parseWeatherIntent`) rather than hoping the LLM always calls the tool.

### Requirement 5: Briefing in conversation

**User Story:** As a user, I want to ask for the Daily Brief or accept/decline a soft offer by voice or text.

#### Acceptance Criteria

1. WHEN `BriefingController.handleUserTurn` returns `play`, THE SYSTEM SHALL speak/return the generated briefing speech and not ask the LLM to invent a brief.
2. WHEN it returns `decline`, THE SYSTEM SHALL acknowledge and not play the brief.
3. WHEN it returns `chat` with `appendOffer`, THE SYSTEM SHALL keep the model reply short and append the offer closer.
4. Tools `play_daily_briefing` and `decline_briefing_offer` SHALL exist on the voice path; cascade Core ports are preferred over a second policy engine.

### Requirement 6: No GPT-Live, no Apple STT, no robot

#### Acceptance Criteria

1. THE SYSTEM SHALL NOT ship LiveKit Agents `AgentSession` / GPT-Live as a v1 stack.
2. THE SYSTEM SHALL NOT register Apple on-device STT or branch on `process.platform === "darwin"` for STT.
3. THE SYSTEM SHALL NOT include expression, robot, or studio-light tools.
