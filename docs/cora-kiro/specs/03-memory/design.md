# Design: Personal memory

## Overview

Port Alfred `memory.local` only. Canonical store = JSONL file. Persona markdown is always-on bootstrap, not retrieved.

Reference: `packages/memory/src/local-provider.ts`, `fact-extractor.ts`, `controller.ts`, `persona.ts`, `persona-templates.ts`. Ignore `oip-local/` and ingest modules.

## Data model

`NormalizedMemoryItem`:

- `id`, `content`, `sourceId`, `createdAt`, `provenance` (`profileId`, `sessionId`, `turnId`, `role`, `kind`)
- Retrieve returns `{ items: [{ ...item, relevance }] }`

Fact `sourceId` conventions:

| sourceId | Example |
| --- | --- |
| `fact:name` | User's name is Devon. |
| `fact:job` | User's job/role is … |
| `fact:preference` | User prefers … |
| `fact:favorite:{noun}` | User's favorite X is Y. |
| `fact:note:{slug}` | Explicit remember-that text |
| `fact:briefing-interest:{slug}` | User wants Daily Brief coverage of {topic}. |

## Briefing-interest extractor (new)

Add patterns on top of Alfred’s extractor, for example:

- `brief me (about|on) X`
- `I want to be briefed (about|on) X`
- `include X in (my )?(daily )?brief`
- `I care about X in (the|my) brief`
- `stop briefing me (about|on) X` → delete or supersede matching interest facts

Keep phrases short (similar 12-token cap). Slug from the topic. Retrieval query for briefing generate: `"daily briefing interests"` plus the day label.

`USER.md` may also hold:

```md
<!-- observed: YYYY-MM-DD | status: active -->

- Prefer Daily Brief coverage of pipeline failures and warehouse cost.
```

## MemoryController

Exactly one active provider. `initialize(preferredId?: "memory.local")`. `retrieve` / `commitTurn` delegate to the active provider. After user commit, run extractor and upsert facts.

## Persona templates

Rewrite Alfred defaults: name CORA, work companion, no butler theatrics required, no Elgato/X ingest guidance. Keep “be resourceful, have opinions, private things stay private.”

## CLI

`pnpm memory -- inspect|persona|export|import` (port a slim `apps/voice-agent` memory CLI without OIP/ingest/X subcommands).

## Testing

Port `local-provider.test.ts` and `fact-extractor.test.ts`. Add cases for briefing-interest upsert and “stop briefing me about X”.
