# Requirements: Platform bootstrap

**Feature:** CORA monorepo and conversation-core skeleton  
**Source of truth for out-of-scope:** `.kiro/steering/scope.md`

## Introduction

Stand up a Windows-friendly pnpm monorepo that can host Conversation Core, provider adapters, JSONL memory, and briefing as libraries. Do not implement product hosting, login, pairing, or HTTP APIs.

## Glossary

- **Host application:** External system (not specified here) that will later serve UI, authenticate users, and start processes.
- **Profile id:** Local string (`CORA_PROFILE_ID`, default `profile.default`) that namespaces memory/persona/briefing files. Not a login identity.

## Requirements

### Requirement 1: Greenfield monorepo

**User Story:** As a developer, I want a typed pnpm workspace so CORA can be built onsite without forking Alfred.

#### Acceptance Criteria

1. WHEN the repo is created, THE SYSTEM SHALL use pnpm workspaces with `packages/*` and `apps/*`, Node 22+, TypeScript strict (`NodeNext`, `ES2022`), and Vitest.
2. WHEN packages are named, THE SYSTEM SHALL use the `@cora/*` scope (not `@alfred/*`).
3. WHEN environment variables for CORA-owned config are defined, THE SYSTEM SHALL use the `CORA_` prefix except for vendor keys (`DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `GROK_API_KEY` / `XAI_API_KEY`, `LIVEKIT_*`).
4. THE SYSTEM SHALL NOT add GNU Make Darwin Apple-STT hooks, Homebrew steps, or Swift native builds.
5. THE SYSTEM SHALL NOT create a product HTTP server, claim/pair flow, device store, or cloud-connect module.

### Requirement 2: Vendor-free contracts

**User Story:** As a developer, I want domain types in one package so OpenAI/LiveKit/Deepgram SDKs never leak into core.

#### Acceptance Criteria

1. WHEN domain types are declared, THE SYSTEM SHALL put Zod schemas and TypeScript types in `@cora/contracts` with no vendor SDK imports.
2. WHEN adapters are written, THE SYSTEM SHALL translate vendor objects at the package boundary (`@cora/provider-*`, `@cora/livekit`).
3. `@cora/core` SHALL depend only on `@cora/contracts` and persistence interfaces.

### Requirement 3: Core skeleton

**User Story:** As a developer, I want the conversation FSM, ledgers, failover, and prompt assembler in place before wiring live providers.

#### Acceptance Criteria

1. THE SYSTEM SHALL implement a hand-rolled conversation state machine with structured transition events (not XState).
2. THE SYSTEM SHALL implement a response ledger with proposed / committed / submitted-to-TTS / delivered / unspoken / abandoned / resumed buckets.
3. THE SYSTEM SHALL implement sticky per-modality failover (ordered provider lists; stay on fallback until retry-primary interval or config change).
4. THE SYSTEM SHALL implement `PromptAssembler` that injects system instructions, persona files, retrieved memory, and extra system hints as structured blocks — not indiscriminate concatenation.
5. THE SYSTEM SHALL implement `SessionOrchestrator` for text turns and a `VoiceSessionController` shell ready for LiveKit media in spec 02.
6. THE SYSTEM SHALL pair `AbortSignal` with typed cancellation reasons.

### Requirement 4: Fake providers and simulator

**User Story:** As a developer, I want deterministic tests without live API keys.

#### Acceptance Criteria

1. THE SYSTEM SHALL register fake STT, LLM, and TTS providers for tests and the simulator.
2. THE SYSTEM SHALL include a text-only simulator (Alfred M1 pattern) that can run scripted turns against fakes.
3. WHEN `pnpm test` runs, THE SYSTEM SHALL execute Vitest across `packages/**/*.test.ts` and `apps/**/*.test.ts` without requiring network keys.

### Requirement 5: Windows-safe data paths

**User Story:** As an operator on Windows, I want memory and briefing files written with `path.join`.

#### Acceptance Criteria

1. WHEN default data directories are resolved, THE SYSTEM SHALL use `path.join` / `path.resolve` under `data/memory`, `data/persona`, and `data/briefing` (overridable by env).
2. THE SYSTEM SHALL treat `CORA_PROFILE_ID` as a filesystem namespace only.
3. `.env.example` SHALL document voice and briefing keys and SHALL NOT document Apple STT, cloud URLs, sidecar secrets, desktop identity paths, or login.

### Requirement 6: No hosting or login

**User Story:** As the platform owner, I will supply hosting and login separately.

#### Acceptance Criteria

1. THE SYSTEM SHALL NOT implement HTTP routes, token-mint endpoints, health product APIs, or a desktop shell server.
2. THE SYSTEM SHALL NOT implement user accounts, OAuth, PIN pairing, QR claim, device bearers, or identity JSON.
3. Packages SHALL export library functions the host can call (e.g. `SessionOrchestrator`, `createLiveKitToken` helper, `loadBriefingPrefs`).
