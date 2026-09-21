# Tasks: Platform bootstrap

- [ ] 1. Scaffold pnpm workspace, `tsconfig.base.json` (strict NodeNext ES2022), Vitest aliases for `@cora/*`, `.gitignore` (`node_modules`, `data/`, `.env`, `dist/`)
  - _Requirements: 1.1, 1.2, 5.1_
- [ ] 2. Add `.env.example` with voice + briefing keys only (no Apple STT, cloud, sidecar, identity)
  - _Requirements: 1.3, 5.3, 6.2_
- [ ] 3. Create `@cora/contracts` with provider-neutral Zod types (pipeline, turns, memory items, persona context, SecretRef, cancellation reasons). No vendor SDKs.
  - _Requirements: 2.1, 2.2_
- [ ] 4. Create `@cora/persistence` repository interfaces + in-memory implementations
  - _Requirements: 3.1_
- [ ] 5. Create `@cora/core`: clock, FSM, event ledger, response ledger, sticky failover, prompt assembler, SessionOrchestrator. Omit ingest/lights/X intents.
  - _Requirements: 2.3, 3.1–3.6_
- [ ] 6. Create `@cora/providers` registry + fake STT/LLM/TTS
  - _Requirements: 4.1_
- [ ] 7. Create `apps/simulator` with scripted text turns against fakes; `pnpm simulate` and `pnpm test` pass without network
  - _Requirements: 4.2, 4.3_
- [ ] 8. Path helpers that resolve `data/*` via `path.join` and `CORA_PROFILE_ID`
  - _Requirements: 5.1, 5.2_
- [ ] 9. Confirm no HTTP host, login, pairing, or token-mint packages exist
  - _Requirements: 1.5, 6.1–6.3_
