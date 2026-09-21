# Tasks: Personal memory

- [ ] 1. Port `LocalFileMemoryProvider` (JSONL load, atomic persist, keyword retrieve, fact-preferring) and `MemoryController`
  - _Requirements: 1.1–1.6, 5.1_
- [ ] 2. Port `extractFactsFromUserText` (name/job/prefer/favorite/remember) with echo-name scrub; wire on user-turn commit
  - _Requirements: 2.1–2.3_
- [ ] 3. Add briefing-interest extraction, upsert, and stop/supersede; include interests in retrieve for briefing generate
  - _Requirements: 3.1–3.4_
- [ ] 4. Port persona seed/load; CORA-named templates; attach in PromptAssembler (soul → identity → user)
  - _Requirements: 4.1–4.4_
- [ ] 5. Slim `pnpm memory` CLI: inspect, persona, export, import only
  - _Requirements: 1.5_
- [ ] 6. Tests: JSONL round-trip across “restart”, extractor cases, briefing-interest add/stop, persona seed
  - _Requirements: 1.1, 2.1, 3.1, 4.1_
- [ ] 7. Confirm no oip-local, embeddings, graph UI, ingest, or memory HTTP API
  - _Requirements: 5.2, 6.1–6.3_
