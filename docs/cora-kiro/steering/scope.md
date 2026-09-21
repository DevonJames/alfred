# CORA v1 scope

Read this before porting any Alfred file. If a feature is listed under Out, do not create packages, routes, UI tabs, env vars, or tests for it.

## In scope

- Cascaded voice conversation (Deepgram Flux → OpenAI/Grok → ElevenLabs) over LiveKit
- Typed chat sharing the same session/prompt/memory brain (`SessionOrchestrator`)
- Talk UI module (waveform, captions, composer)
- Daily Brief preferences UI module (weather, news sources, analytics placeholder)
- JSONL long-term memory (`fact` / `turn` / `note`) with heuristic extraction and keyword retrieve
- Persona bootstrap: `SOUL.md`, `IDENTITY.md`, `USER.md`
- Storing briefing interests as memory facts and USER.md directives
- Daily Brief: greeting, date/time, weather, optional news, Databricks **stub**
- Weather as a live conversational tool (`get_weather_forecast`) using Open-Meteo
- News headline fetch from a curated RSS catalog; user picks sources in the prefs UI
- Soft-offer / explicit-ask / decline briefing-day state machine
- Sticky per-modality failover (STT/LLM/TTS)
- Vitest coverage for memory, briefing prefs/news/weather/intent, conversation happy paths
- Windows-safe filesystem paths (no Darwin/Apple STT)

## Out of scope (do not port)

### Hosting and login (entirely)

Do not port, specify, or invent:

- Alfred’s desktop HTTP host (`apps/desktop-client` as a product server)
- Claim, QR, PIN pair, device-bearer auth, identity/devices JSON
- Cloud control plane / relay / accountless JWT
- Sidecar mode, internal secrets, household session keys
- Public HTTP route tables, health/status product endpoints, token-mint HTTP APIs
- Any login, SSO, or user-account system

The host application owns serving, auth, and process topology.

### Memory visualization and indexes

- Classic memory graph
- Graph (beta) 3D nebula / Semantic Map
- Vector Explorer
- OIP-local filesystem packages, SQLite/FTS, graph adjacency, `FileVectorIndex`
- OpenAI embeddings / PCA / MDS
- ANN retrieval in Talk
- Multi-desktop memory zip merge
- Knowledge-export ingest, PDF/photo ingest, audio notes pipeline

### Clients and hardware

- iOS client and all pairing / CallKit / hold-to-talk phone behavior
- Raspberry Pi kiosk (alfredbot), face, wheels, arms
- Elgato Key Lights
- Apple on-device STT and any `darwin` branch in voice wiring
- GPT-Live / LiveKit Agents `AgentSession`

### Alfred briefing sections that CORA does not want

- Rocket launches / Launch Library
- Crypto, stock index, metals
- X.com / YouTube Apple Notes ingest and “today’s X ingest” briefing section
- Gemini briefing images

### Later / deferred (acknowledge, do not build)

- Postgres persistence
- Unified realtime (OpenAI GPT-Realtime)
- Vendor memory products (Mem0, Letta, Graphiti, Zep)
- Real Databricks report fetching (wait for the separate spec; ship the interface only)
- OpenClaw Gateway as a required dependency (keep `delegate_task` as a stub router only)

## Porting test

Before adding an Alfred file, ask: does this exist to serve Talk, Chat, JSONL memory, weather, news, or the briefing controller? If it exists to serve a graph, a phone, a robot, Apple Speech, crypto/launches, **hosting, or login**, leave it out.
