# CORA — Kiro bootstrap pack

This folder is a **greenfield build spec** for CORA, an onsite conversational assistant. It is **not** a fork of Alfred. Kiro should create a new repository from these documents, using the Alfred tree only as a read-only reference implementation.

Copy this entire `docs/cora-kiro/` directory into the new CORA repo as `.kiro/`, then open that repo in Kiro.

```text
docs/cora-kiro/          →  <cora-repo>/.kiro/
  README.md                  (this file; keep at repo root as KIRO.md as well)
  steering/                  →  .kiro/steering/
  specs/                     →  .kiro/specs/
```

Also copy `steering/*.md` into `.kiro/steering/` and keep them always-on. Specs live under `.kiro/specs/<name>/` with Kiro’s standard `requirements.md`, `design.md`, and `tasks.md`.

## What CORA is

CORA is a work assistant:

- Voice and typed chat with one agent named **CORA**
- Personal long-term memory (preferences, facts, “remember that…”)
- A Daily Brief with a preferences UI
- Briefing content = **Databricks analytics** (schema in a later spec) + **weather** + optional **news headlines**
- Target OS is **Windows**. No macOS Speech / Apple STT. No iPhone client. No robot.

**Hosting, login, authentication, pairing, and HTTP API layout are not part of this pack.** The host application will wire these libraries. Do not port Alfred’s desktop HTTP host, claim/pair flow, device bearers, or cloud relay.

## How to use Alfred

Give Kiro read access to the Alfred repo (this tree). Treat it as a pattern library, not a template to copy wholesale.

| Rule | Meaning |
| --- | --- |
| Reimplement, do not clone | New package names (`@cora/*`), new env prefix (`CORA_*`), new identities (`cora-agent`) |
| Copy conversation behavior | Conversation Core, LiveKit-as-transport, JSONL memory, briefing controller, news RSS, Open-Meteo |
| Do not port out-of-scope systems | See [steering/scope.md](./steering/scope.md) |
| Prefer the smallest Alfred file that already does the job | Mapped in [steering/alfred-reference.md](./steering/alfred-reference.md) |

Suggested Kiro context: attach the Alfred repo path, then implement specs in this order:

1. `specs/01-platform-bootstrap`
2. `specs/02-conversation`
3. `specs/03-memory`
4. `specs/04-daily-brief`

Databricks report sources, queries, and spoken formatting are **intentionally omitted**. Leave a typed `AnalyticsProvider` seam in `@cora/briefing` and wait for a follow-on spec.

## Spec index

| Spec | Outcome |
| --- | --- |
| [01-platform-bootstrap](./specs/01-platform-bootstrap/requirements.md) | pnpm monorepo, contracts/core/providers skeleton, Windows-safe paths, provider env template |
| [02-conversation](./specs/02-conversation/requirements.md) | Cascaded voice (Deepgram → LLM → ElevenLabs) over LiveKit; text turns via SessionOrchestrator; Talk UI module |
| [03-memory](./specs/03-memory/requirements.md) | JSONL memory + SOUL/IDENTITY/USER persona; briefing-interest facts |
| [04-daily-brief](./specs/04-daily-brief/requirements.md) | Prefs model + UI module, weather, news source picker, soft-offer briefing, Databricks stub |

## Non-goals (do not implement)

Memory graph, Graph (beta), Vector Explorer, OIP-local packages, embeddings, iOS, alfredbot, Elgato lights, X/YouTube ingest, Apple Notes, rocket launches, crypto/metals, GPT-Live experimental stack, Apple on-device STT, and **anything related to hosting or login** (desktop HTTP host, claim/pair, device auth, cloud relay, session tokens as a product).
