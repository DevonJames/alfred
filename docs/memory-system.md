# Alfred memory: OIP records, schema.org templates, and how a question is answered

**Status:** Describes the implemented `memory.oip-local` store (`packages/memory/src/oip-local/`). The long product spec is [ALFRED-MEMORY-prd.md](./ALFRED-MEMORY-prd.md). Embeddings as a visualization index are [embedding-space.md](./embedding-space.md).

Alfred’s durable personal memory is a **hybrid of a typed knowledge graph and lexical retrieval**, used to augment the language model. It is a graph memory system with a full-text index beside it. The model never opens the corpus itself. On each question it receives a short, ranked list of current records, chosen by walking names, words, relationship edges, and time.

A vector index exists on disk for the Semantic Map. Talk does not query that index when it answers.

---

## What kind of memory this is

Three ideas get mixed together in “RAG vs graph” discussions. In Alfred they are separate jobs.

| Piece | Role in Alfred |
| --- | --- |
| Knowledge graph | People, places, products, events, and facts are separate records. Connections are explicit edges (`dref`s). A question can start at one record and step to its neighbors. |
| Lexical retrieval | SQLite FTS5 (BM25) finds records whose stored text shares words with the question: names, wine labels, file paths, transcript phrases. |
| Retrieval-augmented generation | The walk’s top hits are written into the prompt (or returned by `search_memory`) as plain lines. The model answers from that block plus the recent conversation. |
| Embeddings | OpenAI vectors under `indexes/vectors/` drive the Graph (beta) Semantic Map and Vector Explorer. They are a rebuildable picture of the corpus, not the answer path. |

So this is a **graph-and-lexical hybrid that augments generation**. It is a graph memory system because relationships are stored and walked. It is retrieval-augmented because the model sees a retrieved slice, not the whole store. It is not a vector RAG pipeline, and it is not a system that fuses embedding neighbors with graph hops at question time.

Personal questions often fail if the only method is “embed the question, fetch similar chunks.” “What was the wine we had at Sarah’s?” needs the person Sarah, the dinner episode, and the product served there, even when the question never says “Barolo.” “Where do I work?” needs the user’s own entity and a `worksAt` edge, even when the question never says the company name. The hybrid walk is built for that.

---

## OIP concepts in the metadata record

Alfred keeps private memory as **OIP-local** packages: the record shape follows Open Index Protocol ideas, and the bytes live in ordinary files under `./data/memory-oip/{profileId}/` (override with the OIP root used by `OipLocalMemoryProvider`). Nothing is published to a public OIP network by default.

Concepts taken from OIP, and how this store uses them:

| OIP idea | Alfred record |
| --- | --- |
| Typed records, separate from their template | Five memory primitives: `Entity`, `Episode`, `Assertion`, `Observation`, `Artifact`. The primitive is `type`. The payload template is `schema` plus `schemaType`. |
| Stable decentralized id | `did:memory:` + a ULID. The id names the continuing thing (Sarah, the dinner, the fact). It does not change when the record is corrected. |
| Content-addressed revision | `revision` is `sha256:` of the canonical JSON. Corrections append a new revision file and point `previousRevision` at the old one. The manifest’s `currentRevision` is the head. |
| Exact historical pin | A ref may be `did:memory:<ulid>#sha256:<hex>`, meaning “that exact revision,” not “whatever is current.” |
| `dref` links | A map of predicate → `did:memory:…` (or an array of them). `subject`, `object`, `participants`, `location`, `sourceArtifact`, `involved`, `occurredAt`, and similar fields are edges. |
| Bounded resolution | `resolveDref` loads the current head, or one pinned revision. `resolveRecordDrefs` can expand nested refs to a default depth of 2. Question-time traversal uses the SQLite edge table built from those same refs, also capped at 2 hops. |
| Provenance and visibility | `provenance` (source, speaker, extraction method, learned time) and `alfred` (confidence, `confidenceLabel`, `visibility`, `assertionType`, `entityClass`, `isSelf`). |

Filesystem layout for one logical memory:

```text
memory/packages/<ulid>/
  manifest.json          id, type, currentRevision
  revisions/
    sha256-<hex>.json    immutable revision
  README.md              short human label
  artifact-refs.json
artifacts/sha256/ab/cd/…  original bytes (audio, pdf, photo, export)
indexes/
  alfred-memory.sqlite   records, FTS, edges, temporal, reminders
  vectors/               optional embeddings for the Semantic Map
```

The package directory is storage. Meaning lives in the revision JSON and the `dref` edges. Deleting `indexes/` loses no memory; `rebuildIndexes()` reconstructs SQLite from the packages.

A revision is one JSON object. The fields that matter for metadata:

```json
{
  "id": "did:memory:01H…",
  "type": "Entity",
  "revision": "sha256:…",
  "previousRevision": null,
  "schemaType": "https://schema.org/Person",
  "schema": { "@type": "Person", "name": "Sarah Miller", "alternateName": ["Sarah"] },
  "alfred": {
    "entityClass": "Person",
    "confidence": 0.95,
    "confidenceLabel": "confirmed",
    "visibility": "private",
    "assertionType": "explicit"
  },
  "drefs": {},
  "provenance": { "sourceType": "conversation_extraction", "speaker": "user" },
  "learnedAt": "2026-09-22T18:00:00.000Z",
  "validFrom": null,
  "validUntil": null
}
```

`learnedAt` is when Alfred stored the fact. `validFrom` / `validUntil` and an episode’s `validTimeStart` / `validTimeEnd` are when the thing was true or happened. Superseding a fact writes a new revision; the old revision file stays.

There is no separate on-disk OIP template registry. The template is the code that fills `schema` and `schemaType`, checked by the Zod `MemoryRevision` envelope in `packages/memory/src/oip-local/schemas.ts`.

---

## schema.org templates

schema.org supplies the **payload vocabulary** inside each primitive. `schemaType` is the schema.org URL. `schema` is a small JSON object whose `@type` is the schema.org name and whose other keys are schema.org properties (`name`, `alternateName`, `email`, `telephone`, `birthDate`, `description`, `category`, `text`, `keywords`).

Constructors live in `packages/memory/src/oip-local/schema-org.ts`:

| Helper | `@type` | `schemaType` |
| --- | --- | --- |
| `schemaOrgPerson(name, aliases)` | `Person` | `https://schema.org/Person` |
| `schemaOrgPlace(name)` | `Place` | `https://schema.org/Place` |
| `schemaOrgProduct(name, extra)` | `Product` | `https://schema.org/Product` |
| `schemaOrgEvent(name, extra)` | `Event` | `https://schema.org/Event` |
| inline organization object | `Organization` | `https://schema.org/Organization` |
| inline creative-work object | `CreativeWork` | `https://schema.org/CreativeWork` |

How the five primitives use those templates:

| Primitive | What it is | schema.org template | How it links |
| --- | --- | --- | --- |
| `Entity` | A lasting thing: person, org, place, product, project | `Person`, `Place`, `Organization`, `Product`, `CreativeWork`, `Thing` | Other records point at it |
| `Episode` | Something that happened (dinner, meeting, audio note) | `Event` | `participants`, `location`, `drefs.occurredAt`, `drefs.involved`, `drefs.hostedBy` |
| `Assertion` | A fact between two records | `Statement` | `subject` / `object` plus `drefs.subject` and `drefs.object`. `predicate` is Alfred’s relation name (`worksAt`, `served`, `reportsTo`, `spouseOf`, `livesIn`, …) |
| `Observation` | A note or extracted passage that is not yet a typed fact | `CreativeWork` | Optional `drefs.related`, `drefs.sourceArtifact` |
| `Artifact` | Stored source bytes | `MediaObject` (`contentSize`, `encodingFormat`) | Referenced as `sourceArtifact` |

`Statement` is the schema.org type used for assertions. It is not one of the `SCHEMA_ORG` URL constants; those constants cover the entity and episode templates. Contact fields stay on the Person schema (`email`, `telephone`, `birthDate`) so a later question can read them off the entity itself.

The same templates are filled from three writers:

- **Conversation.** `remember_memory` and turn extraction call `writeConversationalMemory`. A person becomes `schemaOrgPerson` (or Organization / Place / CreativeWork from `entityClass`). A relationship becomes an `Assertion` whose `schema` is `{ "@type": "Statement", name, text }` and whose `drefs` are the two entity ids.
- **Knowledge export.** Ingest of the v1 JSON export (`packages/memory/src/knowledge-export-schema.ts`) copies each entity’s `schemaType` (a schema.org URL) onto an `Entity`, turns `relationships` into assertions, and stores episodes as `Event` records.
- **Ingest of files.** Docs, photos, PDFs, X posts, YouTube, and audio notes become `CreativeWork`, `ImageObject`, `DigitalDocument`, `SocialMediaPosting`, `VideoObject`, or `AudioObject` / `Event` records, with the original bytes as an `Artifact`.

`alfred.entityClass` is Alfred’s own label (`Person`, `Place`, `Product`, …) stored next to the schema.org type. Retrieval uses both: name lookup is type-agnostic, while relationship ranking prefers an `Organization` schema type for “where do I work” and a `Person` for “who is my boss.”

Persona files (`SOUL.md`, `IDENTITY.md`, `USER.md`) are always-injected markdown. They are not OIP records and are not found by this walk.

---

## How the agent traverses memory

The agent does not crawl packages at question time. `retrieveMemories` (`packages/memory/src/oip-local/retrieval.ts`) asks the SQLite index for candidate ids, fuses scores, then loads only the winners’ **current** revision from disk and formats each as one line.

```text
question
   │
   ├─ 1. relationship walk     self entity → typed assertions → other entities
   ├─ 2. full-text search      FTS5 over name + search text
   ├─ 3. name seeds            "Sarah" → Entity rows
   ├─ 4. graph expansion       1–2 hops along dref edges, both directions
   ├─ 5. source and time boosts   x.com, docs, photos, notes, learned/published window
   │
   ▼
ranked ids (default 5 on a Talk turn, 8 on search_memory)
   │
   ▼
read current revision from the package
   │
   ▼
one line per hit, injected as "Retrieved long-term memory"
```

Scores are fused by keeping the max per id, then adding smaller boosts. Relationship hits are scored first (about 0.85–1.45) so a `worksAt` fact outranks a chatty observation that happens to share words. A proper-name entity match is 0.75. An FTS hit is `0.4 + bm25 × 0.4`. Each graph neighbor of a seed gets +0.15. Source phrases (“on X”, “the docs”, “audio note”) and a parsed date window add further bumps. The list is cut to `limit`.

### Worked example: “What was the wine we had at Sarah’s?”

1. **Name seed.** `Sarah's` becomes the token `Sarah`. `findByName` returns the Person entity and scores it 0.75.
2. **FTS.** “wine” hits the Product whose search text contains the wine’s name or category, and any assertion text that mentions it.
3. **Two-hop expansion.** From Sarah, the edge table (filled by `collectDrefs` at index time) reaches the house (`hostedBy`), the dinner `Episode` (`participants`, `hostedBy`, `occurredAt`), and the wine (`involved`). The `served` assertion sits on the episode and points at the wine.
4. **Episodic product boost.** The question matches dinner/wine phrasing, so Episode nodes, Product entities whose schema or text looks like wine, and edges named `involved`, `served`, `consumed`, or `likes` get extra score.
5. **Load.** The current revisions are formatted. An assertion becomes `Dinner at Sarah's served Marchesi di Barolo 2018`. An entity becomes `Entity: Marchesi di Barolo 2018`. Those lines are what the model sees.

The wine record can rank even though the question never contained “Barolo,” because the graph step, not string overlap alone, pulled it in.

### Worked example: “Where do I work?”

1. **Intent.** `detectRelationshipIntents` marks this as an employer question and turns on self-seeding. The question does not need to contain a company name.
2. **Self.** The walk loads the Entity whose `alfred.isSelf` is true.
3. **Edge walk.** Incoming `subject` / `object` edges find Assertions about that entity. Present-tense employment predicates (`worksAt`, `employedBy`, `hiredBy`) rank above past ones (`workedAt`). Targets whose `schemaType` is `Organization` rank above person-shaped misses.
4. **Result.** The assertion and the organization entity are bumped above ordinary FTS hits, then loaded and formatted as `Devon worksAt USPTO` (names resolved from the linked records, not left as raw `did:memory:` strings).

The same self-seeded walk covers boss (`reportsTo` / `hasSupervisor`), spouse, birthday (`schema.birthDate` and `hasBirthDate`), contact fields, and coworker-plus-place questions. Birthday and phone/email are also copied onto the formatted Person line so the model does not have to open the raw schema.

### What the model actually receives

On a cascaded Talk turn the session moves to `RetrievingMemory`, calls `memory.retrieve({ text, limit: 5 })`, then `PromptAssembler` appends:

```text
Retrieved long-term memory (distinct from recent conversation context):
[1] (id=did:memory:…, relevance=0.9) Dinner at Sarah's served Marchesi di Barolo 2018
[2] …
```

GPT-Live and the cascade `search_memory` tool call the same `retrieve` and return the same style of lines (default limit 8). `remember_memory` writes `Entity` and `Assertion` packages through `writeConversationalMemory`; it does not append a paragraph to a notes file.

After the hits are chosen, formatting in `formatContent` resolves assertion endpoints to display names and attaches source tags (`source=docs`, `file=…`, `learned=…`, `birthDate=…`) so the model can tell a document chunk from a personal fact.

---

## Which surface runs this walk

| Surface | Store it reads |
| --- | --- |
| Desktop `/api/memory`, Graph, Notes, document/photo/audio/X/docs ingest, iOS memory | Always `memory.oip-local`. This walk. |
| `remember_memory`, reminders, daily brief | Always the OIP provider, including when Talk’s active provider is the JSONL file. |
| Cascaded Talk’s automatic retrieve, and `search_memory` | The **active** voice provider. Default is `memory.local` (JSONL keyword facts) until `ALFRED_MEMORY_PROVIDER_ID=memory.oip-local`. |

Point voice at OIP when Talk should answer from the graph described here. Desktop and the phone already do.

---

## Code map

| Concern | File |
| --- | --- |
| Record envelope | `packages/memory/src/oip-local/schemas.ts` |
| schema.org templates | `packages/memory/src/oip-local/schema-org.ts` |
| Packages, canonical hash, manifest | `packages/memory/src/oip-local/package-store.ts` |
| `dref` collect and resolve | `packages/memory/src/oip-local/dref.ts` |
| FTS + edge tables | `packages/memory/src/oip-local/indexes/sqlite-index.ts` |
| 2-hop walk | `packages/memory/src/oip-local/indexes/graph-index.ts` |
| Question-time fusion | `packages/memory/src/oip-local/retrieval.ts` |
| Self and employment walk | `packages/memory/src/oip-local/relationship-recall.ts` |
| Conversation → Entity / Assertion | `packages/memory/src/conversation-memory.ts` |
| Prompt injection | `packages/core/src/prompt-assembler.ts`, `packages/core/src/session.ts` |
| Live `search_memory` | `apps/voice-agent/src/live/tools.ts` |
