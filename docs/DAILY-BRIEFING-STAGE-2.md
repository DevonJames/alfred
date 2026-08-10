# Daily Briefing — Stage 2

**Status:** Planned (not implemented)  
**Depends on:** Stage 1 (`@alfred/briefing`, voice soft offer, `GET /api/briefing`, OIP `listDue`)  
**Reference implementation:** `/Users/devon/Documents/development/alfred-home/backend/src/lib/briefing.ts` and related modules

Stage 1 ships public API sections plus due memory reminders, delivered by voice (soft offer after 4:30 local / explicit ask) and HTTP. Stage 2 adds sections that need connected personal state, an agent harness (OpenClaw or equivalent), or both.

---

## Goals

1. Brief Alfred with household/personal state that cannot be fetched from public APIs alone.
2. Use agentic summarization and lookup where judgment is required (news curation, message triage, security narrative).
3. Keep Stage 1 sections working with graceful degrade when Stage 2 backends are unavailable.
4. Preserve the Stage 1 delivery model: soft offer once per briefing day, explicit natural-language ask anytime, spoken via the normal TTS path.

---

## Out of Stage 1 (do not re-implement here)

Already done or intentionally deferred as non-goals for Stage 1:

| Item | Stage 1 status |
|---|---|
| Weather, launches, markets, raw RSS | Done |
| Due/overdue OIP reminders | Done (`listDue`, surface on play) |
| Time-of-day + optional LLM greeting | Done |
| Soft offer / explicit ask / 4:30 day boundary | Done |
| Gemini briefing image | Deferred (optional later; not required for Stage 2 core) |
| Sticky auto-play preference (skip asking after N yeses) | Optional product polish; can land with Stage 2 |

---

## Stage 2 sections

### 1. Agent-curated news summary

**alfred-home:** `summarizeNews(...)` in `backend/src/lib/agent-tasks.ts`, called from `generateBriefing` after RSS fetch.

- Keep Stage 1 RSS fetch as the data source.
- Prefer agent path (`func:news` / summarize skill → OpenClaw delegation → model fallback).
- Fall back to raw headlines if summarization fails (current Stage 1 behavior).
- Sanitize markdown / strip emoji for speech as alfred-home does.

### 2. Approvals

**alfred-home:** pending rows from `approvals` table; `formatApprovals(...)`; toggle `includeApprovalsInBriefing`.

- Needs an Alfred approvals store (or harness-backed pending-action list).
- Briefing section: count + short titles (up to ~5).
- Invalidate briefing cache when approvals change.

### 3. Messages / inbox triage

Not a first-class section in alfred-home’s `generateBriefing` today, but a natural Stage 2 add for this Alfred product.

- Requires agentic fetch + judgment (email/Telegram/etc. via OpenClaw or another harness).
- Surface a short spoken summary (“3 messages that look important…”) rather than dumping inboxes.
- Must respect privacy boundaries and user-configured accounts.

### 4. Security posture

**alfred-home:** `getSecurityBriefing` / formatters in `backend/src/lib/security-copilot.ts`.

- Depends on vuln / threat-feed / security-approval data populated elsewhere.
- Always-on or settings-gated; spoken summary of posture + notable items.

### 5. Calendar conflicts

**alfred-home:** `detectTodayConflicts` in `backend/src/lib/calendar-conflicts.ts`.

- Needs synced calendar events (DB or live calendar API).
- Overlap / double-book / tight-gap detection for the local day.
- Include in speech; Stage 1 display formatters may omit calendar until UI exists.

### 6. Travel warnings

**alfred-home:** `getTravelWarnings` in `backend/src/lib/travel-time.ts`.

- Calendar events with locations + maps travel-time provider (Apple / Google / OpenRoute).
- Append onto calendar section when present.

### 7. Alarm / wake suggestions

**alfred-home:** `calculateWakeTime` / formatters in `backend/src/lib/schedule-alarms.ts`.

- Per family member prefs + first event of day − prep − commute.
- Spoken wake suggestions; applying alarms (e.g. Shortcuts) is a separate action path.

### 8. Public knowledge discovery (memory PRD)

**PRD:** `docs/ALFRED-MEMORY-prd.md` §35.5 / §55.

- Match new public OIP records against private interest rules.
- Present as recommendations distinct from private reminders.
- Save/dismiss creates private relationship records (`dref` to public object/analysis).
- Requires public discovery index/cache + interest graph — after private reminders are solid.

### 9. Settings, cache, and UI parity

- Household-style toggles for Stage 2 sections (mirroring alfred-home `householdSettings` / `newsPreferences` where useful).
- Same-day briefing cache invalidation on approvals/settings mutations.
- Optional: richer Home/BriefingCard UI, TTS captions polish (alfred-home `BriefingCard.tsx` patterns).

---

## Architecture notes

```text
Stage 1 generateBriefing()
        │
        ├─ public APIs + OIP listDue          (already shipped)
        │
Stage 2 extensions
        ├─ agent tasks (news summary, message triage, optional richer intro)
        ├─ approvals / security stores
        ├─ calendar sync → conflicts + travel + alarms
        └─ public OIP discovery matcher
```

### Harness integration

- Prefer Alfred Conversation Core’s `delegate_task` + `AgentRouter` over embedding OpenClaw tool schemas in every prompt.
- alfred-home paths to port conceptually:
  - `generateBriefingIntro` / `summarizeNews` in `agent-tasks.ts`
  - OpenClaw delegation with model fallback
- Stage 1 already does a simple LLM greeting without OpenClaw; Stage 2 should not regress that fallback.

### Delivery (unchanged contract)

- Briefing day still rolls at `BRIEFING_DAY_START` (default 04:30 local).
- Soft offer once per briefing day; decline suppresses offer only.
- Explicit ask (“brief me”, “ready for the briefing”, etc.) always plays.
- Spoken payload remains TTS-safe (no `[icon:*]` in speech).

---

## Suggested implementation order

1. **Agent news summary** — smallest harness win; clear fallback to Stage 1 RSS.
2. **Approvals store + section** — if Alfred already has (or is about to add) pending actions.
3. **Calendar sync + conflicts** — unlocks travel and alarm suggestions.
4. **Travel warnings + alarm suggestions** — build on calendar.
5. **Messages triage** — harness-heavy; define account scope first.
6. **Security posture** — once vuln/threat data exists.
7. **Public discovery in Daily Brief** — after interest rules + public OIP cache.
8. **Settings / cache invalidation / UI** — as product surface needs them.

---

## Success criteria

- Briefing can include curated news, pending approvals, calendar conflicts, and (when configured) message/security/travel/alarm items without breaking Stage 1 offline/API-only operation.
- Agent failures degrade to Stage 1 content rather than failing the whole brief.
- Voice soft-offer and explicit-ask behavior remain unchanged.
- Public discovery recommendations are clearly distinguished from private remembered facts (memory PRD invariant).

---

## Key alfred-home file map

| Concern | Path |
|---|---|
| Orchestrator | `backend/src/lib/briefing.ts` (`generateBriefing`, formatters) |
| Agent tasks | `backend/src/lib/agent-tasks.ts` |
| Security | `backend/src/lib/security-copilot.ts` |
| Calendar conflicts | `backend/src/lib/calendar-conflicts.ts` |
| Travel | `backend/src/lib/travel-time.ts` |
| Alarms | `backend/src/lib/schedule-alarms.ts` |
| Cache | `backend/src/lib/briefing-cache.ts` |
| Routes | `backend/src/routes/domains.ts` (`GET /api/v1/briefing`) |
| UI | `web/src/components/BriefingCard.tsx` |

## Key Alfred (this repo) extension points

| Concern | Path |
|---|---|
| Stage 1 package | `packages/briefing/` |
| Voice hook | `packages/core/src/voice-session.ts` (`BriefingVoicePort`) |
| Wiring | `apps/voice-agent/src/wiring.ts` |
| HTTP | `apps/desktop-client/src/routes/briefing.ts` |
| Due reminders | `packages/memory/src/oip-local/provider.ts` (`listDue`) |
| Agent router | `packages/agents/` |
| Memory PRD (discovery + due) | `docs/ALFRED-MEMORY-prd.md` §35.5, §41, §55 |
