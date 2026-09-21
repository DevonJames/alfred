# Requirements: Personal memory

**Feature:** JSONL long-term memory + persona bootstrap + briefing interests  
**Depends on:** `01-platform-bootstrap`

## Introduction

CORA remembers people, preferences, and what the user wants in their Daily Brief. Memory is a service Conversation Core invokes. Do not build a graph UI, vector explorer, or OIP-local package store.

## Requirements

### Requirement 1: JSONL provider

**User Story:** As a user, I want CORA to remember facts after a restart.

#### Acceptance Criteria

1. THE SYSTEM SHALL persist memory as JSONL under `CORA_MEMORY_PATH` or `data/memory/{profileId}.jsonl`.
2. THE SYSTEM SHALL store items with kinds `fact`, `turn`, and `note`, each with provenance.
3. WHEN persisting, THE SYSTEM SHALL write a temp file then rename (atomic on the same volume).
4. WHEN retrieving, THE SYSTEM SHALL keyword/token-score items, prefer facts, and return a bounded list (default limit 8, about half facts).
5. THE SYSTEM SHALL expose inspect / export / import of canonical JSONL records (CLI is enough; no hosted UI).
6. THE SYSTEM SHALL register exactly one active long-term memory provider per profile (`memory.local`).

### Requirement 2: Heuristic extraction

**User Story:** As a user, I can say “my name is …”, “I prefer …”, or “remember that …” and have it stored as a fact.

#### Acceptance Criteria

1. WHEN a user turn is committed, THE SYSTEM SHALL extract name, job, preference, favorite, and explicit-remember facts (Alfred `fact-extractor.ts`).
2. WHEN the same `sourceId` is extracted again (e.g. `fact:name`), THE SYSTEM SHALL upsert, not duplicate.
3. THE SYSTEM SHALL scrub obvious echo names (assistant self-reference).

### Requirement 3: Briefing interests

**User Story:** As a user, I want CORA to remember what kinds of things I want in my Daily Brief.

#### Acceptance Criteria

1. WHEN the user says they want to be briefed about a topic (e.g. “brief me about failed jobs”, “I care about warehouse spend in my morning brief”), THE SYSTEM SHALL upsert a `fact:briefing-interest:*` record.
2. WHEN `USER.md` contains briefing-interest directives, THE SYSTEM SHALL always inject them via persona (not only via retrieve).
3. WHEN generating a Daily Brief (spec 04), THE SYSTEM SHALL make retrieved briefing-interest facts available to the analytics stub/provider as `interests: string[]`.
4. THE SYSTEM SHALL allow superseding an interest (“stop briefing me about X”) by marking the fact inactive or replacing the USER.md directive.

### Requirement 4: Persona files

**User Story:** As an operator, I want SOUL / IDENTITY / USER markdown always in the system prompt.

#### Acceptance Criteria

1. On first start, THE SYSTEM SHALL seed `SOUL.md`, `IDENTITY.md`, and `USER.md` under `CORA_PERSONA_DIR` or `data/persona/{profileId}/` if missing.
2. IDENTITY SHALL name the agent **CORA** (not Alfred). SOUL SHALL include work-data boundaries (do not invent metrics; do not leak).
3. USER.md SHALL use imperative directives with `observed` / `status: active|superseded` metadata (Alfred template).
4. Prompt assembly SHALL attach soul → identity → user in that order, with USER truncated at ~12k characters.

### Requirement 5: Conversation integration

**User Story:** As a user, I want Talk and Chat to share the same memory.

#### Acceptance Criteria

1. Both `SessionOrchestrator` and `VoiceSessionController` SHALL retrieve before generating and commit user/assistant turns after.
2. THE SYSTEM SHALL NOT use OIP-local, SQLite graph indexes, or embeddings for v1 Talk retrieval.

### Requirement 6: Out of scope

#### Acceptance Criteria

1. THE SYSTEM SHALL NOT implement memory graph, Graph (beta), Vector Explorer, or embedding rebuild UIs.
2. THE SYSTEM SHALL NOT implement ingest pipelines (PDF, photo, X, YouTube, Apple Notes, knowledge-export).
3. THE SYSTEM SHALL NOT implement a hosted memory HTTP API.
