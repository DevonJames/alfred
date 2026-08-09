# ALFRED MEMORY

## Product Requirements Document

### Private, Temporal, Graph-Based Personal Memory and Retrieval System

**Status:** Draft v1
**Product:** Alfred
**Component:** Memory and Retrieval System
**Primary use case:** Long-term personal memory for conversational AI
**Architecture principle:** OIP-compatible records in filesystem memory packages are the canonical durable private memory; public OIP records describe public web knowledge; SQLite/FTS, vector, lexical, temporal, graph, reminder, and discovery stores are disposable rebuildable indexes.

---

# 1. Executive Summary

Alfred Memory is a long-term personal memory system designed to allow an AI assistant to reliably remember facts, experiences, documents, people, places, preferences, decisions, and relationships accumulated across months or years.

The system must support natural human queries that do not contain the exact words originally used when the information was stored.

Examples:

> "What was the wine we had at Sarah's?"

> "What size filter does the bedroom take?"

> "What was that restaurant Mike recommended?"

> "What did the repair guy say was going to need replacing?"

> "When did Sarah move to Denver?"

> "What was the name of that medicine Matty took last winter?"

> "Didn't somebody recommend a hotel near the convention center?"

A conventional vector RAG system is insufficient as the sole memory architecture because personal-memory queries frequently depend on:

* entities
* relationships
* chronology
* exact facts
* fuzzy contextual associations
* changes over time
* provenance
* source reliability
* inferred versus explicitly stated information

Alfred Memory will therefore use a **filesystem-first hybrid temporal knowledge graph architecture**.

Every significant logical memory is represented as a self-contained filesystem package containing structured OIP-compatible records, immutable content-addressed revisions, human-readable summaries where practical, and links to source artifacts. Semantic embeddings, lexical indexes, structured SQLite tables, and graph adjacency stores are generated as retrieval aids, but none constitutes the authoritative memory.

The architectural distinction is:

**OIP records describe what Alfred knows.**

**`dref` relationships describe how those things are connected.**

**Temporal metadata describes when those things were true and when Alfred learned them.**

**Filesystem memory packages and content-addressed artifacts are the durable source of truth.**

**SQLite/FTS, vector, lexical, temporal, and graph stores are rebuildable indexes.**

**Embeddings help Alfred find potentially relevant memories.**

**Lexical search finds exact words, numbers, names, identifiers, and phrases.**

**Source artifacts establish why Alfred believes something.**

The system should eventually function as a machine-readable autobiographical memory connected selectively to a public machine-readable knowledge graph.

---

# 2. Product Vision

The long-term product goal is:

> Alfred should remember the useful details of a person's life well enough that the user no longer needs to.

A user should be able to tell Alfred:

> "Remember this."

or simply interact naturally with Alfred, provide documents, photographs, audio, messages, receipts, screenshots, and other information.

Alfred should determine:

1. What happened?
2. What entities are involved?
3. What facts were learned?
4. What relationships exist?
5. When was the information true?
6. When did Alfred learn it?
7. Where did the information come from?
8. Does it correct, reinforce, supersede, contradict, or describe a new experience related to anything already known?
9. Should Alfred bring it back to the user's attention at a future date or time?
10. How should it be retrieved later?

The user should not need to manually organize information into folders, tags, notebooks, databases, or projects.

---

# 3. Product Principles

## 3.1 Memory is structured knowledge, not stored chat history

Conversation transcripts may be retained as source material, but Alfred's long-term memory must not consist primarily of searching old conversations.

Useful information should be extracted into independent, typed memory records.

---

## 3.2 Raw sources remain available

Structured extraction can be wrong.

Whenever practical, Alfred must maintain a provenance path from an extracted fact back to the source from which it was learned.

Example:

Answer

→ assertion

→ observation

→ episode

→ original voice recording

This permits verification and later reprocessing.

---

## 3.3 Vectors are indexes, not truth

An embedding represents similarity.

It does not represent authoritative factual state.

The vector index is therefore used for candidate retrieval rather than canonical storage.

---

## 3.4 Relationships are first-class data

"Sarah", "Barolo", "Christmas dinner", and "Sarah's house" should not merely appear as words inside a memory blob.

They should exist as entities connected through explicit relationships.

---

## 3.5 Time is first-class data

Alfred must distinguish:

* when something occurred
* when something became true
* when something stopped being true
* when Alfred learned about it

Historical information should generally be superseded rather than destroyed.

---

## 3.6 Memory must be portable

The canonical memory representation should not depend on:

* OpenAI
* Anthropic
* a particular embedding model
* a particular vector database
* Neo4j
* Graphiti
* Elasticsearch
* a cloud AI vendor

Models and indexing systems should be replaceable adapters.

---

## 3.7 Privacy is architectural

The memory corpus may contain some of the most sensitive information in a user's life.

The architecture must permit the canonical memory store to remain entirely local or under user control.

Cloud AI processing must not be required for basic operation.

---

## 3.8 Filesystem packages are canonical

Alfred Memory should treat the local filesystem as the canonical durable storage layer for private personal memory.

The canonical store is composed of ordinary directories and files owned by the user:

* machine-readable OIP-compatible memory records
* immutable revision files
* package manifests
* original source artifacts
* derived transcripts, OCR, descriptions, and summaries
* optional human-readable README files

This provides portability, local-first operation, backup friendliness, inspectability, and graceful failure if Alfred or any indexing system disappears.

SQLite, FTS, vector stores, graph databases, Elasticsearch/OpenSearch, and similar systems are indexes or adapters over these files. They must be disposable and rebuildable.

---

## 3.9 Logical identity is separate from content identity

A memory's stable logical ID identifies the thing Alfred is talking about.

A revision hash identifies one exact immutable version of that memory's canonicalized contents.

The stable ID remains constant across corrections and refinements. Revision hashes change whenever canonical content changes.

Permanent logical memory IDs must therefore not be derived from mutable memory content.

---

## 3.10 History is append-only

Corrections and refinements create new immutable revisions instead of mutating old revision files.

Historical experiences and events are not rewritten when the user later has a new experience. New experiences create new memories linked through shared entities, places, artifacts, assertions, or higher-level summaries.

This keeps old experiences historically true while allowing Alfred's current-state answers to improve.

---

## 3.11 Private memory and public knowledge have a hard boundary

Alfred should be able to consume and publish public OIP metadata about public web objects, but private user memory must not leak into the public graph by default.

Public knowledge can flow inward for discovery. Private knowledge flows outward only after explicit user authorization.

---

# 4. Existing OIP Foundation

The implementation should extend the existing Open Index Protocol architecture rather than build an unrelated memory schema.

OIP already provides:

* template-defined typed records
* template/record separation
* compact field representation
* decentralized identifiers
* `dref` references between records
* repeated `dref` references
* recursive relationship resolution
* Elasticsearch indexing
* structured querying
* relevance scoring
* multiple storage backends
* private GUN-backed records
* cryptographic identity and ownership mechanisms

For Alfred Memory, OIP becomes the canonical semantic memory protocol, while the local filesystem becomes the preferred canonical durable storage layer for private memory packages and artifacts.

Permanent publication to public networks such as Arweave is **not** required and should not be the default for personal memories.

Public OIP publication is appropriate for metadata and analysis about public web objects when copyright, safety, and trust requirements are satisfied. Private Alfred memories remain local by default.

The logical memory representation and physical storage location must remain separate concepts. OIP-compatible private records may later be synchronized, mirrored, or explicitly published, but private Alfred memory defaults to local filesystem packages. Public OIP records may be referenced from private memory through `dref`s without copying the public record into the private store.

---

# 5. High-Level Architecture

```text
                     INPUT

        Voice       Photo       Document
          │           │             │
          │       Screenshot        │
          │           │             │
          └───────────┼─────────────┘
                      │
                      ▼

               INGESTION LAYER

              transcription
                 OCR/VLM
            metadata extraction
              normalization
                      │
                      ▼

             MEMORY EXTRACTION

              entity extraction
              entity resolution
              event extraction
             assertion extraction
            relationship extraction
             temporal extraction
           provenance attribution
           confidence estimation
                      │
                      ▼

             OIP MEMORY MODEL

        ┌─────────┬───────────┬───────────┐
        │         │           │           │
     Entities   Episodes   Assertions   Artifacts
        │         │           │           │
        └─────────┴──── drefs ┴───────────┘
                      │
                      ▼

          CANONICAL FILESYSTEM STORE

        self-contained memory packages
        immutable content-hashed revisions
        first-class source artifacts
        optional human-readable summaries
                      │
                      ▼

            REBUILDABLE INDEXING LAYER

       ┌────────────┬────────────┬────────────┐
       │            │            │            │
    SQLite/FTS    Lexical      Vector       Graph
    structured      BM25        index        index
       │            │            │            │
       └────────────┴──────┬─────┴────────────┘
                           │
                           ▼

                 HYBRID RETRIEVAL

                     query parser
                          │
                  candidate retrieval
                          │
                    graph expansion
                          │
                 temporal filtering
                          │
                      reranking
                          │
                    source loading
                          │
                          ▼

                         LLM
                          │
                          ▼

                     USER ANSWER
```

---

# 6. Canonical Memory Model

The initial implementation should use a deliberately small number of fundamental memory primitives.

Avoid creating dozens of specialized memory types prematurely.

The initial five private memory primitives are:

1. Entity
2. Episode
3. Assertion
4. Artifact
5. Observation

Each primitive is stored inside a logical memory package. A package may represent an Entity, Episode, Assertion, Observation, Artifact record, or another future memory type.

Public knowledge records are separate OIP-compatible record types used for public web discovery. They may be referenced by private memory packages but are not themselves private memories.

---

## 6.1 Logical memory packages

Each logical memory is a self-contained package rooted at a stable logical memory ID.

Example:

```text
memory/
  packages/
    01K3S8YB7Q9M6R4Z2N0E1A5C8P/
      manifest.json
      README.md
      revisions/
        blake3-3f7a....json
        blake3-9c21....json
      derived/
        transcript.md
        image-description.md
      artifact-refs.json

artifacts/
  blake3/
    ab/
      cd/
        blake3-abcdef....heic

indexes/
  alfred-memory.sqlite
  vectors/
  lexical/
  graph/
```

The exact directory sharding strategy is an implementation detail. Directory hierarchy is only for storage organization, sync ergonomics, and filesystem performance. It must never be treated as the semantic graph.

Semantic meaning comes from OIP-compatible record fields, typed relationships, temporal metadata, provenance, and `dref` references.

---

## 6.2 Stable logical IDs and immutable revision hashes

Alfred must distinguish two forms of identity:

```text
Stable logical memory ID
did:memory:01K3S8YB7Q9M6R4Z2N0E1A5C8P

Immutable revision ID
blake3:3f7a...
```

The stable logical memory ID identifies the continuing memory. It SHOULD use a non-content-derived identifier such as ULID, UUIDv7, or an equivalent time-sortable random ID.

The revision ID identifies exact canonical revision content. It is derived from the canonicalized revision bytes and changes whenever canonical content changes.

BLAKE3 is the preferred local content hash for memory revisions and source artifacts because it is fast and streaming-friendly. If interoperability with an existing OIP hashing convention requires another algorithm, the hash must be explicitly algorithm-tagged and the interoperability requirement must be documented.

---

## 6.3 Manifest and revision chain

Each package contains a small manifest that points to the current revision and records package-level metadata.

Example:

```json
{
  "id": "did:memory:01K3S8YB7Q9M6R4Z2N0E1A5C8P",
  "type": "Episode",
  "currentRevision": "blake3:9c21...",
  "createdAt": "2026-12-24T21:14:00-08:00",
  "updatedAt": "2026-12-25T10:03:00-08:00"
}
```

Revision files are immutable and append-only.

Example revision:

```json
{
  "id": "did:memory:01K3S8YB7Q9M6R4Z2N0E1A5C8P",
  "revision": "blake3:9c21...",
  "previousRevision": "blake3:3f7a...",
  "type": "Episode",
  "payload": {
    "name": "Dinner at Sarah's",
    "validTimeStart": "2026-12-24T18:00:00-08:00"
  }
}
```

Changing historical revision files is forbidden except as an explicit repair operation that produces an integrity warning and rebuild trail. Corrections create new revisions whose `previousRevision` points to the prior head.

---

## 6.4 Canonicalization for hashing

Revision hashes must be computed over a deterministic canonical byte representation.

Canonicalization requirements:

* use a documented canonical JSON form for records
* sort object keys deterministically
* use deterministic array ordering where order is semantic, and explicit ordering fields where order matters
* normalize strings consistently
* normalize timestamps to a documented RFC 3339 representation
* normalize relative paths to portable POSIX-style paths
* exclude the revision hash field itself or hash with a documented placeholder
* preserve integer, decimal, boolean, and null types without lossy conversion
* hash binary artifacts over raw bytes

Any canonicalization change is a storage-format migration and must be versioned.

---

## 6.5 `dref` reference semantics

OIP `dref` references should default to stable logical memory IDs:

```text
did:memory:01K3S8YB7Q9M6R4Z2N0E1A5C8P
```

This means "resolve the current authoritative revision of this logical memory."

When provenance, auditability, or reproducibility requires an exact historical version, a `dref` MAY target a specific revision:

```text
did:memory:01K3S8YB7Q9M6R4Z2N0E1A5C8P#blake3:3f7a...
```

This means "this relationship or assertion was derived from that exact revision."

Hash-only identifiers should not be used as the primary logical relationship target because content hashes identify bytes, not the continuing semantic thing.

---

# 7. Entity

An Entity represents a persistent identifiable thing in the user's world.

Examples:

* person
* organization
* place
* household
* vehicle
* device
* product
* wine
* restaurant
* medication
* pet
* document issuer
* appliance
* property
* account
* book
* movie

An Entity persists across multiple memories.

Example:

```json
{
  "entity": {
    "name": "Sarah",
    "entityType": "Person",
    "aliases": ["Sarah Miller"],
    "schemaType": "https://schema.org/Person"
  }
}
```

Entities SHOULD align with schema.org types where an appropriate schema exists.

Alfred-specific extensions should be used where schema.org is insufficient.

---

# 8. Episode

An Episode represents something that happened.

Examples:

* dinner at Sarah's
* conversation with contractor
* doctor's appointment
* vacation
* school meeting
* purchase
* repair visit
* birthday party
* phone call
* trip

Example:

```json
{
  "episode": {
    "name": "Dinner at Sarah's",
    "episodeType": "social_event",
    "participants": [
      "did:memory:person-james",
      "did:memory:person-sarah"
    ],
    "location": "did:memory:place-sarah-home",
    "validTimeStart": "2026-12-24T18:00:00-08:00",
    "validTimeEnd": "2026-12-24T22:00:00-08:00"
  }
}
```

Episodes are particularly important because human autobiographical memory is heavily episodic.

Queries frequently reference the event rather than the fact itself.

---

# 9. Assertion

An Assertion represents a discrete proposition Alfred believes may be true.

Examples:

```text
James likes Barolo 2018.

Sarah lives in Denver.

Bedroom HVAC uses a 20×20×1 filter.

Mike recommended Chez Panisse.

The garage door spring will probably need replacement next year.
```

Assertions SHOULD be represented relationally when practical:

```text
subject
predicate
object
```

Example:

```json
{
  "assertion": {
    "subject": "did:memory:james",
    "predicate": "likes",
    "object": "did:memory:wine-123",
    "confidence": 0.97,
    "validFrom": "2026-12-24",
    "validUntil": null,
    "learnedAt": "2026-12-24T21:14:00-08:00",
    "source": "did:memory:observation-933"
  }
}
```

Assertions are the primary factual layer.

---

# 10. Observation

An Observation represents what Alfred actually perceived or was told.

Example:

> "This is fantastic, although I don't know if it's seventy-dollar fantastic."

That observation may support the assertion:

```text
James strongly liked Wine X.
```

The observation should preserve enough original language to explain why the assertion was generated.

Example:

```json
{
  "observation": {
    "text": "This is fantastic, although I don't know if it's seventy-dollar fantastic.",
    "speaker": "did:memory:james",
    "observedAt": "2026-12-24T21:14:00-08:00",
    "sourceArtifact": "did:memory:audio-9201"
  }
}
```

---

# 11. Artifact

An Artifact represents original source material or a derived file used for provenance.

Examples:

* image
* screenshot
* photograph
* receipt
* PDF
* email
* voice recording
* transcript
* video
* scanned document
* web page
* message
* calendar item

Source artifacts are first-class content-addressed objects. Alfred should store each unique source artifact once, keyed by content hash, and allow any number of memory packages to reference it.

The artifact record should preserve:

* source type
* original file or external reference
* creation timestamp where available
* ingestion timestamp
* extracted text
* content hash
* hash algorithm
* MIME type
* byte size
* original filename where available
* relevant metadata
* ownership/access permissions
* derivation relationship for transcripts, OCR, summaries, thumbnails, or VLM descriptions

Example:

```json
{
  "artifact": {
    "id": "did:memory:artifact-01K3...",
    "contentHash": "blake3:abcdef...",
    "mimeType": "image/heic",
    "originalFilename": "IMG_9282.HEIC",
    "storedAt": "artifacts/blake3/ab/cd/blake3-abcdef....heic",
    "ingestedAt": "2026-12-24T21:14:00-08:00"
  }
}
```

Artifacts establish provenance and deduplication. If five memories refer to the same 40 MB video, the canonical artifact bytes should be stored once and referenced five times.

---

# 12. Relationship Model

Relationships should normally be represented through OIP `dref` references and typed assertions.

By default, `dref`s point to stable logical memory IDs. Revision-specific `dref`s are reserved for provenance or audit cases where Alfred must prove that an assertion was derived from an exact historical revision.

Example:

```text
[James]
   │
   │ participatedIn
   ▼
[Dinner at Sarah's]
   │
   ├── hostedBy ─────> [Sarah]
   │
   ├── occurredAt ───> [Sarah's House]
   │
   └── involved ─────> [Marchesi di Barolo 2018]
                              │
                              └── likedBy ───> [James]
```

The storage system does not need to physically be a graph database for the information model to be graph-shaped.

OIP records and `dref` relationships remain canonical.

A dedicated graph index MAY be introduced for traversal performance.

The filesystem directory hierarchy must not encode semantic graph relationships. A path such as `people/sarah/events/christmas/wine` incorrectly gives a graph-shaped memory one filesystem parent. Storage paths may group, shard, or package records, but all semantic relationships must live in records and `dref`s.

---

# 13. Temporal Model

Alfred must support bi-temporal memory.

Every temporal fact should support two distinct dimensions where applicable.

## 13.1 Valid time

When was this true in the real world?

Example:

```text
Sarah lives in Denver
valid_from: 2026-06-12
```

## 13.2 Knowledge time

When did Alfred learn it?

Example:

```text
learned_at: 2026-08-20
```

If the user says on August 20:

> "Sarah moved to Denver back in June."

the two timestamps differ.

This distinction must be supported from the first production schema because it is difficult to retrofit later.

## 13.3 Reminder and scheduled surfacing time

Alfred must also distinguish temporal facts about the memory from scheduled surfacing metadata.

Fields such as `eventTime`, `validFrom`, `validUntil`, and `learnedAt` describe the memory itself.

`remindAt` describes when Alfred should bring that memory back to the user's attention.

Example:

```json
{
  "summary": "Passport expires November 18, 2027",
  "eventTime": "2027-11-18",
  "remindAt": "2027-05-18",
  "reminderReason": "expiration",
  "reminderStatus": "pending"
}
```

These fields must not be conflated. A passport expiration date is a fact about the world. The reminder date is a requested or derived surfacing schedule.

Reminder-capable memory records SHOULD support:

```text
remindAt
reminderTimezone
reminderStatus
reminderRecurrence
reminderReason
reminderCreatedAt
reminderCompletedAt
reminderLastSurfacedAt
reminderSnoozedUntil
```

`remindAt` may be either a date-only value or a full timestamp. Alfred must preserve that distinction.

Date-only example:

```json
{
  "summary": "Call the insurance company",
  "subject": "did:memory:person-devon",
  "remindAt": "2026-08-15",
  "reminderTimezone": "America/Los_Angeles",
  "reminderStatus": "pending",
  "reminderReason": "user_requested"
}
```

Timestamp example:

```json
{
  "summary": "Call the insurance company",
  "subject": "did:memory:person-devon",
  "remindAt": "2026-08-15T09:00:00-07:00",
  "reminderTimezone": "America/Los_Angeles",
  "reminderStatus": "pending",
  "reminderReason": "user_requested"
}
```

If the user says "on Friday" or "on August 15th" without a time, Alfred must not silently invent a time such as 9 AM. A date-only reminder is eligible for that day's daily brief and other date-level surfacing.

Initial reminder statuses:

```text
pending
surfaced
completed
dismissed
snoozed
```

Initial reminder reasons:

```text
user_requested
deadline
follow_up
expiration
maintenance
derived
```

User-requested reminders should be clearly distinguishable from reminders Alfred inferred from deadlines, expirations, maintenance intervals, or follow-up opportunities.

Reminder metadata belongs on the memory record or package revision so that scheduled surfacing points to the full memory graph, not just a disconnected task string.

---

# 14. Supersession and Historical Facts

Existing assertions must not normally be overwritten when the world changes.

Example:

```text
Bedroom HVAC filter:
16×20×1
valid: 2024-01-01 through 2028-04-03

Bedroom HVAC filter:
20×20×1
valid: 2028-04-03 onward
```

A current-state query:

> "What filter does the bedroom take?"

returns:

> 20×20×1.

A historical query:

> "What filter did the old bedroom unit use?"

returns:

> 16×20×1.

The relationship between assertions should support:

```text
supersedes
contradicts
reinforces
duplicates
derivedFrom
```

Corrections to the same logical assertion or episode create new package revisions. New real-world experiences create new memories.

Example:

```text
Correction:
"That bottle cost $75, not $70."
→ new revision of the same logical assertion/memory

New experience:
"I had that Barolo again last night and didn't like it as much."
→ new episode linked to the same wine entity
→ optional new current-preference assertion
```

The old episode remains historically true. Alfred may update current-state answers through superseding assertions, but it must not rewrite the older experience as though it never happened.

---

# 15. Provenance

Every nontrivial assertion SHOULD include provenance whenever available.

Minimum provenance fields:

```text
source
sourceType
speaker/author
learnedAt
confidence
extractionMethod
```

Optional fields:

```text
model
modelVersion
promptVersion
artifactOffset
transcriptTimecode
documentPage
imageRegion
sourceRevision
```

Provenance references SHOULD point to stable logical IDs by default. When an assertion depends on the exact bytes of a source memory revision, provenance MAY include a revision-specific reference such as:

```text
did:memory:01K3S8YB7Q9M6R4Z2N0E1A5C8P#blake3:3f7a...
```

Example provenance chain:

```text
Answer:
"The wine was Marchesi di Barolo 2018."

       ↓ supportedBy

Assertion:
Wine served at Sarah's dinner = Marchesi di Barolo 2018

       ↓ derivedFrom

Observation:
Bottle photographed during dinner

       ↓ extractedFrom

Artifact:
IMG_9282.HEIC
```

---

# 16. Confidence

Assertions should carry confidence information.

Potential confidence sources include:

* explicit user statement
* direct OCR
* direct document field
* visual extraction
* model inference
* relationship inference
* external enrichment

Suggested confidence classes:

```text
confirmed
high
medium
low
inferred
```

The system SHOULD retain a numeric score internally.

Answers should avoid presenting weak inference with the same authority as explicit user-provided information.

---

# 17. Entity Resolution

Entity resolution is one of the highest-risk components.

When processing:

> "Had dinner with Sarah last night."

the system must determine whether "Sarah" refers to an existing Entity.

Resolution signals may include:

* exact name
* aliases
* relationship to user
* location
* surrounding entities
* conversation context
* recency
* embedding similarity
* contact records
* historical associations

The system must support:

```text
resolved
probably_resolved
ambiguous
new_entity
```

If confidence is high, use the existing entity.

If confidence is uncertain, preserve ambiguity instead of silently merging unrelated people.

Entity merges must be reversible.

---

# 18. Memory Ingestion Pipeline

Each new memory input follows a common pipeline.

## Stage 1: Preserve source

Store or reference the original artifact as a first-class content-addressed object.

Do this before AI extraction whenever practical.

Successful memory capture must not be acknowledged until the source artifact or raw input has been durably written or explicitly linked.

---

## Stage 2: Normalize

Depending on source:

Audio:

```text
audio → transcript
```

Image:

```text
image → VLM/OCR description + extracted fields
```

Document:

```text
document → text + document structure
```

Conversation:

```text
turn(s) → normalized episode
```

---

## Stage 3: Determine memory worthiness

Not everything should become permanent memory.

Classify candidate information into:

```text
ephemeral
session
short-term
long-term
user-explicit
```

Explicit:

> "Remember that..."

should default to long-term.

The user must be able to override this behavior.

---

## Stage 4: Extract candidate objects

The extraction model identifies:

* entities
* episodes
* observations
* assertions
* temporal references
* relationships
* preferences
* quantities
* identifiers
* source provenance
* reminder intent
* scheduled surfacing fields
* public web object identity
* public analysis publication eligibility

---

## Stage 5: Entity resolution

Match candidate entities against existing entities.

---

## Stage 6: Assertion comparison

For each new assertion determine:

```text
new information
duplicate
reinforcement
correction to existing memory
new experience involving existing entities
contradiction
supersession
```

---

## Stage 7: Record creation

Create a new logical memory package when Alfred learns about a new entity, episode, observation, assertion, or artifact record.

When Alfred is correcting or refining the same logical memory, append a new immutable revision and update only the package manifest's current-revision pointer.

Do not mutate historical revision files.

---

## Stage 8: Indexing

Generate/update disposable indexes:

* structured index
* SQLite tables
* FTS/BM25 lexical index
* embeddings
* graph adjacency index
* temporal index
* reminder/scheduled-surfacing index

All indexes must be rebuildable from canonical filesystem packages and content-addressed artifacts.

---

# 19. Memory Extraction Output Contract

The memory extraction LLM MUST return structured output.

Example:

```json
{
  "entities": [],
  "episodes": [],
  "observations": [],
  "assertions": [],
  "relationships": [],
  "temporalReferences": [],
  "scheduledSurfacing": {
    "remindAt": null,
    "reminderTimezone": null,
    "reminderStatus": null,
    "reminderRecurrence": null,
    "reminderReason": null
  },
  "publicKnowledge": {
    "isPublicSource": false,
    "canonicalPublicObjectId": null,
    "publicationEligible": false,
    "recommendedPublicRecordType": null
  },
  "memoryImportance": 0.82,
  "ambiguities": [],
  "needsResolution": []
}
```

Freeform model prose must never directly become canonical memory.

Schema validation is mandatory.

If the user asks Alfred to "remind me" about something on a future date or time, extraction must produce both the normal memory content and the scheduled surfacing fields.

If the source is a public web object, extraction should also identify the canonical public object, whether public metadata publication is allowed, and whether the result should become a private memory, a public analysis candidate, or both.

---

# 20. Schema Strategy

The memory schema should use a layered ontology.

## Layer 1: Generic Alfred memory primitives

```text
Entity
Episode
Assertion
Observation
Artifact
```

## Layer 2: Standard semantic types

Prefer schema.org-compatible types where practical:

```text
Person
Organization
Place
PostalAddress
Event
Product
CreativeWork
Recipe
MedicalEntity
Vehicle
Offer
Invoice
ContactPoint
```

## Layer 3: Alfred-specific extensions

Examples:

```text
alfred:Preference
alfred:Recommendation
alfred:Decision
alfred:HouseholdObject
alfred:Conversation
alfred:Task
alfred:PersonalFact
alfred:Relationship
alfred:Interest
alfred:InterestRule
alfred:PublicObject
alfred:PublicAnalysis
alfred:PrivateKnowledgeRelationship
```

Do not distort information merely to fit schema.org.

---

# 21. Retrieval Requirements

A user query must not be handled by vector search alone.

Retrieval consists of:

1. query interpretation
2. entity identification
3. structured retrieval
4. lexical retrieval
5. vector retrieval
6. graph expansion
7. temporal filtering
8. candidate fusion
9. reranking
10. source loading
11. answer generation

Discovery retrieval additionally compares private interest records against public OIP knowledge records. This must be treated as recommendation retrieval, not as recall from the user's private memory.

---

# 22. Query Interpretation

Example:

> "What was the wine we had at Sarah's?"

The query interpreter should infer approximately:

```json
{
  "intent": "personal_memory_lookup",
  "targetEntityType": "Product",
  "targetSubtype": "Wine",
  "relatedEntities": [
    {
      "name": "Sarah",
      "type": "Person"
    }
  ],
  "relationshipHints": [
    "consumed",
    "served",
    "visited",
    "event"
  ],
  "timeConstraint": null,
  "expectsExactFact": true
}
```

This representation guides the retrievers.

---

# 23. Structured Retrieval

Structured retrieval uses explicit metadata.

Examples:

```text
entityType = Product
category = Wine
relatedPerson = Sarah
```

This is particularly important for precise personal recall.

---

# 24. Lexical Retrieval

BM25/full-text search should remain part of the pipeline.

It is often superior to embeddings for:

* names
* model numbers
* serial numbers
* exact phrases
* vintages
* addresses
* confirmation numbers
* dimensions
* product codes
* unusual proper nouns

---

# 25. Semantic Retrieval

Embeddings should be generated for selected textual representations.

Potential embedding surfaces:

* entity descriptions
* episode summaries
* observations
* assertion text
* artifact summaries
* aliases

Embeddings retrieve conceptually similar candidates when vocabulary differs.

Example:

Query:

> "the red wine at Sarah's"

Stored text:

> "Marchesi di Barolo 2018"

The semantic index may identify the appropriate episode even when the product name itself does not match.

---

# 26. Graph Retrieval

Graph traversal expands candidates through relationships.

Example:

```text
Query identifies Sarah

Sarah
 ↓ related episodes

Christmas Dinner
 ↓ involved products

Marchesi di Barolo 2018
```

Graph traversal should initially support configurable hop limits.

Recommended MVP:

```text
default: 2 hops
maximum: 4 hops
```

OIP `resolveDepth` semantics may inform this implementation.

---

# 27. Temporal Retrieval

Temporal filtering/ranking must support:

```text
current
historical
before
after
during
around
last
first
most recent
```

Examples:

> "Where does Sarah live?"

Prefer currently valid assertion.

> "Where was Sarah living when we visited her in 2024?"

Use historical temporal intersection.

---

# 28. Hybrid Candidate Fusion

Each retrieval subsystem returns candidates with independent scores.

Example:

```text
structuredScore
lexicalScore
semanticScore
graphScore
temporalScore
recencyScore
confidenceScore
publicTrustScore
noveltyScore
personalRelevanceScore
```

A fusion layer combines those results.

Initial implementation may use weighted reciprocal-rank fusion rather than requiring a learned ranking model.

Weights should be configurable.

Do not assume semantic similarity is always the dominant signal.

---

# 29. Reranking

After candidate fusion, a reranker evaluates the top candidate set against the original question.

Inputs should include:

* query
* candidate record
* relationship path
* temporal metadata
* provenance
* retrieval scores

The reranker should prefer records that:

1. directly answer the question
2. have strong relational relevance
3. satisfy temporal constraints
4. have authoritative provenance
5. have high confidence

---

# 30. Answer Generation

The final LLM should receive only the relatively small set of retrieved evidence required to answer the question.

It should not receive the user's entire memory graph.

Example context:

```text
QUERY:
What was the wine we had at Sarah's?

ENTITY:
Sarah Miller

EPISODE:
Christmas dinner at Sarah Miller's house
December 24, 2026

PRODUCT:
Marchesi di Barolo
Vintage: 2018

OBSERVATION:
James: "This is fantastic, although I don't know if it's
seventy-dollar fantastic."

CONFIDENCE:
High

SOURCE:
Photo IMG_9282 + voice transcript
```

Answer:

> It was the 2018 Marchesi di Barolo. You liked it a lot, although you said you weren't sure it was "$70 fantastic."

---

# 31. Retrieval Explainability

Internal retrieval results SHOULD preserve the path that produced an answer.

Example:

```text
Sarah
 → hosted
Christmas Dinner
 → served
Marchesi di Barolo 2018
 → likedBy
James
```

This will aid:

* debugging
* user trust
* retrieval evaluation
* model evaluation
* future UI explanations

---

# 32. Memory Corrections

Users must be able to say:

> "That's not right."

> "I meant the other Sarah."

> "That wasn't at Sarah's; it was at Mike's."

> "I don't like that wine anymore."

Corrections must produce explicit append-only updates rather than silently modifying unrelated records or mutating historical revision files.

A correction should:

1. locate referenced assertion
2. create correction observation
3. determine whether the user is correcting the same logical memory or describing a new experience
4. append a new immutable revision to the corrected logical memory where appropriate
5. invalidate/supersede incorrect assertions where appropriate
6. create corrected assertions
7. preserve revision history/provenance
8. update rebuildable indexes

Example:

```text
"That wasn't at Sarah's; it was at Mike's."
→ new revision of the same episode package
→ previous revision remains intact
→ manifest points to the corrected revision

"I don't like that wine anymore."
→ new observation/assertion about current preference
→ usually not a rewrite of the old dinner episode
```

---

# 33. Forgetting and Deletion

The user must be able to request:

> "Forget that."

> "Forget everything about X."

> "Delete that recording but keep the summary."

Deletion semantics must distinguish:

```text
delete artifact
delete extracted memory
delete entity
delete episode
delete all connected user-owned information
```

Private/local records must support actual deletion.

The system should not rely on immutable public storage for private memories.

Append-only revision history is a local integrity model, not a requirement to retain private data forever. User-authorized deletion may remove canonical memory packages or artifact bytes. Alfred should record tombstones where useful for consistency, then rebuild affected indexes from the remaining canonical store.

---

# 34. Storage Architecture

The canonical private Alfred Memory store is the filesystem.

Canonical records should use OIP-compatible data structures, but the preferred durable storage layout is:

```text
alfred-memory/
  memory/
    packages/
      <logical-memory-id>/
        manifest.json
        README.md
        revisions/
          <hash>.json
        derived/
        artifact-refs.json
  artifacts/
    blake3/
      <sharded-content-hash>/
  indexes/
    alfred-memory.sqlite
    vectors/
    lexical/
    graph/
  storage-format.json
```

Only `memory/`, `artifacts/`, and storage-format metadata are canonical. `indexes/` can be deleted and recreated.

Supported index, mirror, or public-knowledge adapters may include:

```text
SQLite
SQLite FTS5 / BM25
local vector index
graph adjacency index
Elasticsearch/OpenSearch
GUN
public OIP knowledge network
trusted public knowledge mirrors
future graph DB
future decentralized store
```

These adapters are not the source of truth for private memory.

Recommended separation:

```text
Canonical filesystem store
  memory packages + artifact objects
       │
       ├── structured SQLite index
       ├── lexical FTS/BM25 index
       ├── vector index
       ├── temporal index
       └── graph adjacency index
```

Indexes are disposable.

They must always be rebuildable from the canonical filesystem store.

## 34.1 Memory package requirements

Each logical memory package MUST include:

* stable logical ID
* memory type
* manifest with current revision pointer
* immutable revision files
* hash-linked revision history
* provenance references where available
* optional human-readable README

The manifest may change to point at a newer revision. Revision files must not be rewritten during normal operation.

## 34.2 Artifact store requirements

Original source artifacts MUST be treated as first-class content-addressed objects where practical.

Artifact storage requirements:

* content hash uses BLAKE3 by default for local storage
* hash algorithm is stored with the hash
* identical artifact bytes deduplicate to one stored object
* memory packages reference artifact hashes rather than duplicating large files
* derived artifacts preserve their source artifact and extraction provenance
* external artifacts may be referenced without copying only when Alfred cannot or should not store the bytes

## 34.3 Canonicalization and hashing

All immutable revision hashes MUST be computed from canonicalized content according to the storage format version.

The hash function for local Alfred Memory revisions and artifacts SHOULD be BLAKE3. If OIP interoperability requires SHA-256, Arweave transaction IDs, or another content-addressing convention, Alfred must keep the algorithm explicit and avoid mixing untagged hashes.

## 34.4 Integrity verification

Alfred must be able to verify:

* each revision file's canonicalized bytes match its revision hash
* each revision's `previousRevision` points to an existing prior revision or null
* each package manifest points to an existing current revision
* each revision chain is append-only and hash-linked
* each artifact's bytes match its content hash
* each `dref` resolves to either a known logical memory or an intentionally missing/deleted target
* indexes contain no knowledge that cannot be traced back to canonical packages or artifacts

Manual edits to old revision files should be detected as integrity failures rather than silently accepted.

## 34.5 Rebuild behavior

Alfred must support full index regeneration:

```text
canonical filesystem store
        ↓
scan packages and artifacts
        ↓
verify hashes and revision chains
        ↓
resolve current revisions
        ↓
rebuild SQLite/FTS/vector/graph/temporal/reminder/public-discovery indexes
```

If `alfred-memory.sqlite`, the vector index, or the graph index is deleted or corrupted, Alfred should be able to reconstruct retrieval state from the filesystem without memory loss.

## 34.6 Portability and human readability

The canonical store should remain useful without Alfred running.

Requirements:

* ordinary files and directories
* documented JSON schemas
* relative paths where practical
* optional `README.md` summaries in memory packages
* no required cloud service for reading canonical records
* no required proprietary database to recover source artifacts
* backup and sync friendliness

The product promise is: user's memories are not trapped in Alfred; they are ordinary files the user owns.

---

# 35. Public Knowledge and Distributed Discovery

Alfred Memory should support a public knowledge layer for public web objects that many Alfred nodes may encounter independently.

The public web item already exists. Alfred must not republish the source content by default. Instead, an Alfred node that processes a public item may publish a public OIP metadata or analysis record about that item.

Examples of public web objects:

* YouTube video
* GitHub repository
* X post
* blog post
* paper
* website
* podcast episode
* public documentation page

This creates a distributed discovery network:

```text
PUBLIC WEB
   ↓
Alfred node encounters public item
   ↓
extracts structured metadata and analysis
   ↓
publishes public OIP record
   ↓
other Alfred nodes discover record
   ↓
compare against private user interests
   ↓
surface relevant items in Daily Brief
   ↓
user decides whether to save/link privately
```

The intended product behavior is discovery, not automatic private memorization.

If a new public record matches a user's private interest graph, Alfred may brief the user:

> A new tutorial on maintaining character consistency in generative video was indexed yesterday. It looks related to your generative-content work. Want me to add it to your memory?

No private memory is created merely because a public record was discovered. If the user accepts, Alfred creates a private relationship to the public record.

## 35.1 Public object, public analysis, private relationship

The system must distinguish three concepts.

### Public object

The thing on the public internet.

Example fields:

```json
{
  "type": "PublicObject",
  "canonicalId": "webcontent:youtube:ABC123",
  "canonicalUrl": "https://www.youtube.com/watch?v=ABC123",
  "sourceType": "video",
  "title": "New technique for consistent AI characters",
  "creator": "Example Creator",
  "publishedAt": "2026-08-08T15:00:00Z",
  "contentHash": "blake3:...",
  "sourceMetadata": {
    "durationSeconds": 1243,
    "platform": "youtube"
  }
}
```

The public object record establishes identity. It does not make any one node's interpretation authoritative.

### Public analysis

What a specific Alfred node or publisher claims about the public object.

Example fields:

```json
{
  "type": "PublicAnalysis",
  "target": "webcontent:youtube:ABC123",
  "analysisRevision": "blake3:...",
  "summary": "A workflow for maintaining character consistency in AI-generated video.",
  "topics": [
    "generative content creation",
    "video generation",
    "character consistency",
    "ComfyUI"
  ],
  "claims": [
    "The workflow uses reference images to maintain identity across shots."
  ],
  "skillsOrTechniques": [
    "character reference workflow",
    "video generation pipeline"
  ],
  "indexedAt": "2026-08-09T04:15:00Z",
  "indexedBy": "did:oip:...",
  "model": "...",
  "confidence": 0.82
}
```

Multiple public analyses may exist for the same public object:

```text
PUBLIC OBJECT
YouTube: ABC123
      │
      ├── Analysis A by node X
      ├── Analysis B by node Y
      └── Analysis C by node Z
```

The first node to publish establishes an early record, not the final truth.

### Private relationship

What the public object means to a specific user.

Examples:

```text
Devon saved this.
Devon liked this.
Devon wants to revisit this.
Devon learned a technique from this.
Devon dismissed this recommendation.
```

Private relationship records remain in the user's private memory store and may `dref` the public object or a specific public analysis.

Example:

```json
{
  "type": "PrivateKnowledgeRelationship",
  "subject": "did:memory:person-devon",
  "predicate": "saved",
  "object": "did:oip:public-analysis-...",
  "reason": "User approved from Daily Brief",
  "createdAt": "2026-08-09T08:23:00-07:00"
}
```

Do not duplicate the full public analysis into private memory unless offline durability, user annotation, or trust requirements justify a local snapshot.

## 35.2 Canonical public object identity and deduplication

Public objects need stable normalized identifiers so different Alfred nodes converge on the same object.

Preferred canonical IDs for known platforms:

```text
youtube:video:<video-id>
github:repo:<owner>/<repo>
github:commit:<owner>/<repo>/<sha>
x:post:<post-id>
arxiv:<paper-id>
doi:<doi>
```

For arbitrary web pages, use:

```text
normalized URL
+ content hash where available
+ retrieval timestamp/version metadata
```

Canonicalization rules should remove tracking parameters, normalize host casing, normalize known short URLs, and preserve platform-specific identifiers.

Examples that should resolve to one object:

```text
https://youtube.com/watch?v=ABC123
https://youtu.be/ABC123
https://www.youtube.com/watch?v=ABC123&utm_source=newsletter
```

All public object identifiers and hashes must be algorithm-tagged and canonicalization-versioned.

## 35.3 Publication policy

Publishing public metadata is allowed only for public source material and only for metadata, summaries, transformations, and references that Alfred is allowed to publish.

Alfred must not publish:

* private user memories
* private annotations
* private interest records
* private engagement behavior
* copyrighted source copies beyond permitted metadata or short excerpts
* private files merely because they mention public URLs

Public knowledge can flow inward freely. Private knowledge flows outward only after explicit user authorization.

This is an architectural invariant.

## 35.4 Interest graph and discovery matching

User interests should be private graph records, not simple keyword subscriptions.

Example:

```text
Devon
 ├── interestedIn -> generative content creation
 │                     ├── video generation
 │                     ├── image generation
 │                     ├── AI filmmaking
 │                     └── ComfyUI
 └── stronglyInterestedIn -> local AI
```

Interest rules may include:

```json
{
  "type": "InterestRule",
  "topic": "did:memory:topic-humanoid-robotics",
  "minimumNovelty": "high",
  "minimumSignificance": "high",
  "briefingEligible": true,
  "cadence": "daily",
  "sourceTrustThreshold": 0.7
}
```

Discovery matching compares new public OIP records against the user's private interest graph using structured topics, graph relationships, lexical signals, embeddings, novelty, significance, recency, and trust.

The user's interest graph should remain local/private. Alfred should not need to publish a user's interests in order to discover relevant public records.

## 35.5 Daily Brief public discovery

Daily Brief generation should eventually combine:

1. scheduled private memories
2. overdue reminders
3. private follow-up items
4. new public OIP records matching private interest rules
5. personally relevant public knowledge updates

Public discovery candidates should be ranked by:

* personal relevance
* novelty
* significance
* source trust
* analysis confidence
* recency
* diversity across interests
* prior user feedback

The Daily Brief should present public discoveries as recommendations and ask whether the user wants to save or learn them.

If the user accepts, Alfred creates a private relationship record that `dref`s the public object or analysis.

If the user dismisses the item, Alfred may create a private negative-feedback relationship for future ranking, without publishing that behavior by default.

## 35.6 Trust, reputation, and abuse resistance

The public knowledge layer must assume adversarial input.

Risks:

* spam and SEO poisoning
* low-quality analysis records
* maliciously wrong topic labels
* prompt injection inside public content
* Sybil attacks from many coordinated nodes
* stale or changed public content
* public content disappearing
* copyright violations

Mitigations should include:

* signed publisher identity where available
* source canonicalization and content versioning
* multiple analyses per object
* analysis provenance and model metadata
* trust weighting by publisher, original creator, or corroboration
* local prompt-injection isolation for public content processing
* copyright-aware storage limits
* user-controlled trust thresholds
* abuse reporting or suppression lists

Reputation should not be based only on who published first. It should emerge from corroboration, user outcomes, and trusted publisher signals.

Potential aggregate utility signals:

```text
indexed by N nodes
saved by N users
marked useful by N users
used successfully N times
dismissed N times
corroborated by trusted analyses
```

Aggregate signals should be privacy-preserving. Alfred must not expose identifiable user behavior without explicit consent.

## 35.7 Freshness and versioning

Public objects can change.

Examples:

* GitHub repositories receive commits
* documentation pages are edited
* videos are removed or descriptions change
* X posts are deleted
* web pages change content at the same URL

Public object records should distinguish stable object identity from observed versions.

For mutable sources, analyses should reference the observed version, retrieval timestamp, content hash where possible, and source metadata needed to determine whether re-analysis is required.

## 35.8 Local public knowledge cache

Alfred may maintain a local cache or index of public OIP records for matching and Daily Brief generation.

This cache is not the source of truth for private user memory. It is rebuildable from the public OIP network or configured public knowledge mirrors.

Private relationship records that reference public objects remain canonical in the user's private filesystem memory store.


---

# 36. Graph Database Requirement

A dedicated graph database is **not required for MVP**.

The first implementation may create graph relationships from OIP `dref`s and maintain adjacency indexes inside the existing database/indexing layer.

A later dedicated adapter may support:

* Neo4j
* FalkorDB
* Kuzu
* Memgraph
* another graph engine

The canonical data model must not depend on any of them.

---

# 37. Graphiti Evaluation

Graphiti should be evaluated as:

1. a reference implementation
2. a potential extraction/entity-resolution component
3. a potential temporal graph indexing component

It should not automatically become the canonical memory representation.

The team should specifically study its handling of:

* entity extraction
* entity resolution
* episodic memory
* temporal relationships
* invalidation
* graph retrieval
* hybrid retrieval
* provenance

Any Graphiti integration should sit behind an adapter boundary.

---

# 38. Model Independence

Every AI-dependent stage should use the existing Alfred model-provider abstraction where possible.

Independent model roles include:

```text
memory extraction
entity resolution
query interpretation
reranking
answer generation
embedding
```

The user or deployment should be able to select different models for different jobs.

Example:

```text
memory extraction → local model
embeddings → local model
query interpretation → fast local model
reranking → hosted model
answer generation → preferred conversation model
```

No memory should become inaccessible because a model provider changes.

---

# 39. Privacy Modes

The system should eventually support at least three privacy profiles.

## Local Only

All:

* canonical filesystem memories
* embeddings
* extraction
* retrieval
* generation

remain local.

---

## Private Hybrid

Canonical filesystem memories remain local.

Selected content may be sent to user-approved external models for inference.

---

## User Managed

Advanced users configure:

* index/mirror backends
* model providers
* embedding model
* encryption
* synchronization
* external publishing

---

# 40. Multi-User / Household Memory

The architecture should anticipate multiple users even if MVP initially supports one.

Each record should support:

```text
owner
subjects
visibility
sharedWith
accessPolicy
```

Examples:

```text
Private to James
Private to Amy
Shared household memory
Shared family memory
Child-related household memory
```

Do not assume all memories within one Alfred installation belong to everyone.

---

# 41. API Requirements

Initial APIs should conceptually support:

## Add memory

```http
POST /api/memory
```

Input may contain:

```text
text
artifact
audio
image
metadata
source
```

---

## Search memory

```http
POST /api/memory/search
```

Options:

```text
query
entityTypes
dateRange
relationshipDepth
retrievalModes
limit
```

---

## Ask memory

```http
POST /api/memory/ask
```

Performs full query interpretation, hybrid retrieval, and answer generation.

---

## Index public source

```http
POST /api/public-knowledge/index
```

Accepts a public URL or source identifier, canonicalizes the public object, extracts metadata and analysis, and prepares a publishable public OIP record if policy allows.

---

## Publish public analysis

```http
POST /api/public-knowledge/publish
```

Publishes metadata or analysis for a public object. This endpoint must reject private memories, private annotations, and private user behavior unless the user explicitly authorizes publication.

---

## Discover public knowledge

```http
POST /api/public-knowledge/discover
```

Matches new or updated public OIP records against private user interest rules and returns recommendation candidates for briefing or review.

---

## Save public knowledge privately

```http
POST /api/memory/link-public
```

Creates a private relationship from the user or a private memory to a public object or public analysis after user approval.

---

## Get due memories for daily brief

```http
GET /api/memory/due?date=2026-08-15&timezone=America/Los_Angeles
```

Returns pending memories whose `remindAt` date or timestamp is due for the user's current briefing window, including overdue reminders that have not been completed, dismissed, or rescheduled.

---

## Mark reminder surfaced

```http
POST /api/memory/:id/reminder/surfaced
```

Updates reminder metadata by appending a new memory revision or reminder-state revision, preserving history.

---

## Complete, dismiss, or snooze reminder

```http
POST /api/memory/:id/reminder/status
```

Supported actions include `completed`, `dismissed`, and `snoozed`. Snoozing must set a new due date or timestamp.

---

## Get entity

```http
GET /api/memory/entity/:id
```

---

## Get episode

```http
GET /api/memory/episode/:id
```

---

## Get provenance

```http
GET /api/memory/assertion/:id/provenance
```

---

## Correct memory

```http
POST /api/memory/correct
```

---

## Forget memory

```http
DELETE /api/memory/:id
```

---

## Verify memory store

```http
POST /api/memory/verify
```

Verifies canonical package revisions, artifact hashes, revision chains, manifests, and index provenance.

---

## Rebuild memory indexes

```http
POST /api/memory/rebuild-indexes
```

Regenerates disposable SQLite/FTS/vector/graph/temporal indexes from the canonical filesystem store.

---

# 42. Internal Adapter Interfaces

Recommended interfaces:

```text
MemoryStore
MemoryPackageStore
RevisionStore
IntegrityVerifier
IndexRebuilder
StructuredIndex
GraphIndex
VectorIndex
LexicalIndex
EmbeddingProvider
MemoryExtractor
EntityResolver
QueryInterpreter
CandidateReranker
MemoryAnswerer
ReminderScheduler
DailyBriefMemorySelector
PublicObjectCanonicalizer
PublicKnowledgePublisher
PublicKnowledgeDiscoveryIndex
InterestMatcher
TrustReputationScorer
ArtifactStore
ContentAddressedArtifactStore
```

Each should be independently replaceable.

---

# 43. MVP Scope

The first production implementation should deliberately avoid trying to solve all possible human memory.

MVP should support:

### Inputs

* typed/spoken text
* conversational memories
* photographs
* screenshots
* basic documents
* public URLs and source identifiers

### Core memory

* entities
* episodes
* assertions
* observations
* artifacts
* scheduled surfacing metadata for reminders and daily brief inclusion
* private interest records and interest rules
* private relationships to public OIP records

### Canonical storage

* filesystem memory packages
* stable logical memory IDs
* immutable revision files
* append-only revision chains
* canonical JSON hashing
* BLAKE3 local content hashes
* content-addressed artifact storage
* disposable/rebuildable SQLite/FTS/vector/graph indexes
* disposable/rebuildable reminder due-date index
* disposable/rebuildable public discovery cache/index

### Entity classes

At minimum:

* Person
* Place
* Product
* Organization
* Event
* Device
* Vehicle
* HouseholdObject
* Document

### Relationships

At minimum:

```text
relatedTo
participatedIn
occurredAt
owns
uses
recommended
likes
dislikes
purchased
locatedAt
memberOf
sourceOf
derivedFrom
supersedes
contradicts
interestedIn
stronglyInterestedIn
saved
dismissed
publicDref
```

### Retrieval

* structured
* lexical/BM25
* vector
* graph expansion
* temporal filtering
* hybrid ranking
* public discovery matching against private interest rules

### Time

* event time
* valid-from
* valid-until
* learned-at

### Provenance

* source links
* original text
* extraction confidence

---

# 44. Explicit MVP Non-Goals

Do not initially attempt:

* autonomous computer use
* autonomous external actions
* financial transactions
* arbitrary web workflow execution
* automatic publication of private memories
* perfect ontology coverage
* perfect entity resolution
* unlimited graph traversal
* fully autonomous memory consolidation
* psychological modeling
* emotion inference as authoritative fact
* automatic deletion based solely on model judgment
* automatic publication of private data
* treating the first public analysis of an object as authoritative
* public discovery ranking without trust/spam controls

---

# 45. Reference Scenario 1: Wine at Sarah's

Input:

> "Remember this wine we had at Sarah's. It's fantastic, although I'm not sure it's seventy-dollar fantastic."

Bottle photograph attached.

Expected extraction:

```text
Entity:
James

Entity:
Sarah

Entity:
Sarah's home

Entity:
Marchesi di Barolo 2018

Episode:
Dinner at Sarah's

Observation:
"This is fantastic..."

Assertion:
James strongly likes Marchesi di Barolo 2018

Assertion:
Observed price approximately $70

Relationships:
James → participatedIn → Dinner
Sarah → hosted → Dinner
Dinner → occurredAt → Sarah's home
Dinner → involved → Wine
James → likes → Wine
```

Later query:

> "What was the wine we had at Sarah's?"

Expected result:

> The 2018 Marchesi di Barolo. You said it was fantastic, although you weren't sure it was worth $70.

---

# 46. Reference Scenario 2: Changing Household Fact

2026 input:

> "Remember, the bedroom air filter is 16 by 20 by 1."

Create:

```text
Bedroom HVAC → usesFilter → 16×20×1
validFrom: 2026
```

2028 input:

> "We replaced the bedroom HVAC. The new one takes 20 by 20 by 1."

System:

* identifies existing bedroom HVAC entity
* determines hardware replacement may constitute a new entity
* ends validity of old relationship
* creates replacement entity if warranted
* establishes relationship between old and new equipment
* creates new current filter assertion

Query:

> "What size filter does the bedroom take?"

Answer:

> 20×20×1.

Query:

> "What size did the old bedroom system use?"

Answer:

> 16×20×1.

---

# 47. Reference Scenario 3: Recommendation

Input:

> "Mike says we should try Chez Panisse next time we're in Berkeley."

Extract:

```text
Mike → recommended → Chez Panisse

Recommendation target:
James / household

Place:
Chez Panisse

Location:
Berkeley

Source:
conversation
```

Query months later:

> "What was that restaurant somebody recommended in Berkeley?"

Retrieval:

```text
Berkeley
 ← locatedIn
Chez Panisse
 ← recommended
Mike
```

Expected answer:

> Chez Panisse. Mike recommended it.

---

# 48. Reference Scenario 4: Document Memory

User photographs HVAC service invoice.

Extract:

```text
Entity:
HVAC system

Entity:
service company

Episode:
HVAC service visit

Artifact:
invoice image

Assertions:
service date
amount paid
technician name
parts replaced
recommended future maintenance
```

Later query:

> "What did the HVAC guy say we'd probably need to replace?"

Expected system behavior:

* graph search through HVAC entity
* related service episode
* relevant extracted assertion
* retrieve provenance from invoice or associated note
* answer with confidence/source

---

# 49. Evaluation Framework

Memory quality must be measured with repeatable tests.

Build a benchmark corpus of synthetic and real consenting test memories.

Test query categories:

### Exact factual recall

> "What's the serial number of the router?"

### Semantic recall

> "What was that wine at Sarah's?"

### Relational recall

> "What restaurants has Mike recommended?"

### Temporal recall

> "Where did Sarah live before Denver?"

### Episodic recall

> "What happened when the HVAC technician came?"

### Fuzzy recall

> "What was that thing somebody told me about the garage door?"

### Contradiction handling

> New information changes previous truth.

### Ambiguous entity resolution

> Multiple people named Sarah.

### Provenance

> "Where did you get that from?"


### Public discovery relevance

> New public records match a user's private interest graph.

### Public trust and spam resistance

> Low-quality or adversarial public analyses are downranked or suppressed.

---

# 50. Retrieval Metrics

Track:

```text
Recall@K
MRR
nDCG
answer accuracy
entity-resolution accuracy
temporal accuracy
provenance accuracy
false-memory rate
unsupported-answer rate
public-discovery relevance
public-analysis trust calibration
spam/adversarial suppression rate
```

The most important product metric is:

**Can Alfred correctly retrieve a useful memory from the vague description a human naturally remembers?**

---

# 51. Reliability Requirement

When memory evidence is insufficient, Alfred should say so.

The system must distinguish:

```text
I remember this.
I think this is what you mean.
I found two possibilities.
I inferred this.
I don't have enough information.
```

Confident fabrication is a critical failure.

---

# 52. Performance Goals

Initial production targets:

```text
query interpretation: <500 ms preferred
first retrieval candidates: <500 ms preferred
hybrid retrieval: <1 second preferred
complete memory answer: conversational latency target
```

Index lookup should remain fast enough that memory retrieval does not materially damage Alfred's real-time conversational feel.

Memory indexing may occur asynchronously after immediate conversational acknowledgement, but the raw input must be durably captured before acknowledgement of successful storage.

---

# 53. Memory Importance

Every observation need not be given equal long-term retrieval weight.

Potential importance signals:

* user explicitly said "remember"
* repeated reference
* strong preference
* important personal entity
* financial/legal/medical relevance
* future utility
* frequency
* recency
* relationship centrality

Importance should influence ranking but not determine truth.

---

# 54. Consolidation

The system should eventually perform controlled memory consolidation.

Example:

Repeated memories:

```text
James orders Dr Pepper.
James chose Dr Pepper again.
James says he prefers Dr Pepper to Coke.
```

May produce:

```text
Assertion:
James prefers Dr Pepper to Coke.
```

However:

* source observations remain
* consolidation is reversible
* inferred facts are marked as inferred
* the system does not destroy underlying episodic evidence

Automated consolidation can be limited or disabled in MVP.

---

# 55. Daily Brief Reminder Inclusion

Daily Brief generation must query memory for due scheduled surfacing records.

The daily brief pipeline should be:

```text
Create Daily Brief
       ↓
Determine user's local date/time and briefing window
       ↓
Query disposable reminder index
       ↓
Find pending reminders with remindAt due or overdue
       ↓
Retrieve canonical memory packages
       ↓
Resolve relevant drefs/context
       ↓
Query private interest rules against new public OIP records
       ↓
Rank public discovery candidates by relevance, novelty, significance, and trust
       ↓
Build briefing prompt from private reminders and public discovery recommendations
       ↓
Append surfaced-state metadata where appropriate
```

The reminder query should use due-or-overdue semantics rather than exact-date-only semantics. A missed daily brief must not permanently lose a reminder.

Conceptual SQLite query:

```sql
SELECT record_id
FROM memory_reminders
WHERE reminder_status IN ('pending', 'surfaced')
  AND remind_at_sort_key <= :briefing_window_end
  AND (reminder_snoozed_until IS NULL OR reminder_snoozed_until <= :briefing_window_end)
ORDER BY remind_at_sort_key ASC;
```

Date-only reminders are due for the user's local date. Timestamp reminders are due when their timestamp falls within or before the briefing window.

Daily Brief prompt construction should include the whole relevant memory context, not only the reminder summary.

Example prompt evidence:

```text
REMINDER
Call Sarah about the cabin.

RELATED MEMORY
Sarah offered the cabin for the October trip.

RELATED PEOPLE
Sarah

RELATED EPISODE
Conversation on July 12

RELATED ARTIFACT
Original voice note
```

This allows Alfred to brief the user with context:

> You wanted to call Sarah today about using her cabin for the October trip.

Daily Brief inclusion is an index/query behavior over canonical memory records and public OIP discovery indexes. It must not require a separate reminder database as the source of truth.

For public discoveries, the Daily Brief should clearly distinguish "Alfred found something public that may interest you" from "Alfred remembers this about you." User approval creates the private relationship record.

---

# 56. Integrity and Index Rebuild

Because filesystem memory packages and content-addressed artifacts are canonical, every index representation must be reproducible.

Required capability:

```text
canonical filesystem packages
        ↓
integrity verification
        ↓
current revision resolution
        ↓
index reconstruction process
        ↓
complete SQLite/FTS/vector/graph/temporal/reminder/public-discovery indexes
```

Rebuild must cover:

* SQLite structured indexes
* FTS/BM25 indexes
* vector indexes
* graph adjacency indexes
* temporal indexes
* reminder/scheduled-surfacing indexes
* public discovery indexes and caches
* retrieval metadata caches

Integrity verification must cover:

* revision content hashes
* append-only revision chains
* manifest current-revision pointers
* artifact content hashes
* `dref` resolution
* index provenance back to canonical packages
* public discovery cache provenance back to public OIP records

No index should contain irreplaceable knowledge.

---

# 57. Future Extensions

The architecture should leave room for:

* calendar ingestion
* email ingestion
* message ingestion
* contacts
* health records
* location history
* household sensors
* browser/share-sheet capture
* voice recording analysis
* meeting extraction
* personal preference modeling
* daily briefing
* task extraction
* reminders
* agentic actions
* household multi-user memory
* robot observations
* user-owned memory synchronization
* portable encrypted memory archives
* public OIP web knowledge publishing
* trusted public knowledge mirrors
* privacy-preserving public utility/reputation signals

---

# 58. Future Agent Integration

The memory system should remain independent of autonomous action.

Future agentic Alfred may ask memory:

> "What mechanic does James normally use?"

Memory answers.

The agent may then use that information to perform a task.

The memory subsystem does not itself execute the external action.

This separation provides:

* safer operation
* clearer responsibilities
* independent testing
* easier provider replacement

---

# 59. Future "Life Inbox" Integration

This memory system should form the foundation of a later consumer-facing Life Inbox.

User input:

```text
voice
photo
screenshot
document
share sheet
recording
```

Alfred determines whether the content contains:

```text
memory
task
event
person
place
recommendation
document
decision
preference
```

Memory becomes the common semantic layer through which those modules interact.

---

# 60. Key Architectural Decisions

The following decisions should be considered foundational unless implementation evidence strongly argues otherwise.

### Decision 1

OIP is the canonical semantic representation.

### Decision 2

The local filesystem is the preferred canonical durable storage layer for private Alfred Memory.

### Decision 3

Canonical memory and physical storage location are separate concepts. A filesystem package can contain OIP-compatible records without requiring public OIP publication.

### Decision 4

Personal memories default to private local-first storage.

### Decision 5

Memory is represented as interconnected records rather than conversation chunks.

### Decision 6

Each logical memory is a self-contained package with a stable logical ID.

### Decision 7

Stable logical memory IDs are separate from immutable revision content hashes.

### Decision 8

Revision files are immutable and append-only.

### Decision 9

Revision history is hash-linked through `previousRevision`.

### Decision 10

Revision hashes are computed from canonicalized record content.

### Decision 11

BLAKE3 is the preferred local content hash for revisions and artifacts unless OIP interoperability requires another explicitly tagged algorithm.

### Decision 12

`dref` relationships default to stable logical memory IDs.

### Decision 13

Revision-specific `dref`s are allowed for provenance and auditability.

### Decision 14

Directory hierarchy is for storage organization only and must not encode the semantic graph.

### Decision 15

Source artifacts are first-class content-addressed objects.

### Decision 16

Duplicate artifact bytes should be stored once and referenced by content hash.

### Decision 17

SQLite, FTS/BM25, vector indexes, temporal indexes, graph indexes, Elasticsearch/OpenSearch, and graph databases are disposable indexes/adapters, not canonical stores.

### Decision 18

Hybrid retrieval combines structured, lexical, semantic, graph, and temporal signals.

### Decision 19

Raw artifacts and observations are retained for provenance where practical.

### Decision 20

Facts support valid time and knowledge time.

### Decision 21

Reminder/scheduled-surfacing time is distinct from event time, valid time, and learned time.

### Decision 22

User-requested reminders are stored on memory records/packages, not in a disconnected reminder database.

### Decision 23

Daily Brief generation includes due and overdue pending reminders by querying rebuildable indexes over canonical memory records.

### Decision 24

Corrections create new revisions instead of mutating historical revision files.

### Decision 25

New experiences/events create new memories rather than rewriting old episodes.

### Decision 26

Assertions distinguish explicit information from model inference.

### Decision 27

All indexes must be rebuildable from canonical filesystem packages and artifacts.

### Decision 28

Integrity verification must detect hash mismatches, broken revision chains, missing artifacts, and index knowledge without canonical provenance.

### Decision 29

AI providers must remain replaceable.

### Decision 30

Public web objects may have public OIP metadata records; Alfred must not republish source content by default.

### Decision 31

Public object identity is separate from public analysis. The first node to publish does not become authoritative.

### Decision 32

Multiple public analyses may exist for the same public object and should be ranked by trust, provenance, corroboration, freshness, and user outcomes.

### Decision 33

Private user relationships to public objects are private memory records and should `dref` public OIP records rather than duplicate them by default.

### Decision 34

Private interest graphs drive public discovery matching locally. User interests must not be published merely to receive recommendations.

### Decision 35

Daily Brief generation may include public discovery recommendations, but must clearly distinguish them from private remembered facts.

### Decision 36

Public metadata publication must include trust, spam, copyright, freshness, and prompt-injection controls from the start.

### Decision 37

Public knowledge can flow inward freely; private knowledge flows outward only after explicit user authorization.

---

# 61. Recommended Initial Implementation Order

## Phase 0 — Filesystem Store and Integrity

Build:

* storage-format versioning
* filesystem package layout
* stable logical memory ID generation
* canonical JSON serialization
* BLAKE3 hashing for revisions and artifacts
* append-only revision chain validation
* content-addressed artifact store
* reminder/scheduled-surfacing fields
* basic index rebuild command

Success condition:

A manually created memory package can be hashed, verified, corrected by appending a revision, and reindexed from the filesystem with no database as source of truth.

---

## Phase 1 — Canonical Memory Model

Build:

* Entity template
* Episode template
* Assertion template
* Observation template
* Artifact template
* temporal fields
* reminder/scheduled-surfacing fields
* provenance fields
* `dref` relationships
* default stable-ID `dref` resolution
* optional revision-specific provenance `dref` resolution

Success condition:

Manually created memory packages can represent the reference scenarios correctly.

---

## Phase 2 — Memory Extraction

Build structured LLM extraction:

```text
text → canonical memory candidates
```

Then add:

```text
image → memory
document → memory
audio → memory
```

Success condition:

Reference scenarios and user-requested reminders produce valid OIP-compatible memory packages, scheduled surfacing metadata, and content-addressed artifact references.

---

## Phase 3 — Entity Resolution

Implement:

* candidate matching
* aliases
* confidence
* safe merge
* reversible merge
* ambiguity handling

Success condition:

Repeated mentions of known people/products reliably attach to existing entities.

---

## Phase 4 — Retrieval

Implement:

* query interpretation
* structured SQLite search
* FTS/BM25
* embeddings in a disposable vector index
* 1–2 hop graph expansion from rebuildable adjacency indexes
* temporal filters
* reminder due-date retrieval for Daily Brief
* reciprocal-rank fusion
* reranking

Success condition:

Natural vague queries retrieve the expected source records after indexes are rebuilt from the filesystem store.

---

## Phase 5 — Conversational Integration

Expose:

```text
remember()
recall()
correct()
forget()
```

to Alfred's conversational agent.

Success condition:

A user can naturally store, retrieve, correct, and delete memories without understanding the underlying system. Corrections append revisions; new experiences create new memories.

---

## Phase 6 — Public Knowledge Discovery

Build:

* public object canonicalization for known platforms
* public analysis record schema
* private interest and interest-rule records
* local public OIP discovery cache
* trust/reputation scoring interface
* Daily Brief public recommendation selection
* private save/dismiss relationship flow

Success condition:

A public YouTube video, GitHub repository, or web page can be canonicalized, represented as a public object, associated with one or more public analyses, matched against a private interest rule, surfaced as a Daily Brief recommendation, and saved privately only after user approval.

---

## Phase 7 — Evaluation

Build a regression benchmark.

Every change to:

* embeddings
* extraction prompts
* entity resolution
* ranking
* graph logic
* reminder due-date logic
* Daily Brief memory selection
* public object canonicalization
* public discovery matching
* trust/reputation scoring
* canonicalization
* revision hashing
* index rebuild logic

must be tested against the memory benchmark.

---

# 62. MVP Acceptance Criteria

The first production-quality milestone is complete when all of the following work reliably:

1. User can explicitly tell Alfred to remember a fact.

2. Alfred durably stores the raw input or source artifact before acknowledging successful memory capture.

3. Alfred converts that statement into valid OIP-compatible filesystem memory packages.

4. Each logical memory has a stable logical ID that is not derived from mutable content.

5. Each memory revision has an immutable content hash computed from canonicalized content.

6. Revision history is append-only and hash-linked.

7. Corrections create new revisions instead of mutating historical revision files.

8. New experiences/events create new memories rather than rewriting old episodes.

9. Alfred can identify previously known entities.

10. Alfred can associate memories with people, places, objects, and episodes.

11. Alfred stores source provenance.

12. Alfred stores both event/valid time and learning time where appropriate.

13. Alfred stores source artifacts as first-class content-addressed objects.

14. Duplicate artifact bytes are deduplicated and referenced by content hash.

15. `dref`s resolve stable logical IDs by default.

16. Revision-specific provenance references can resolve exact historical revisions.

17. Alfred can store a user-requested future reminder as `remindAt` plus reminder metadata on the relevant memory.

18. Alfred preserves date-only reminders separately from timestamp reminders.

19. Alfred can index pending reminders by due date/time in SQLite without making SQLite canonical.

20. Daily Brief generation includes pending reminders due today or overdue, resolves their relevant memory graph context, and avoids losing reminders when a prior briefing did not run.

21. Alfred can mark reminders surfaced, completed, dismissed, or snoozed without mutating historical revision files.

22. Alfred can retrieve information through exact lexical queries.

23. Alfred can retrieve information through semantically different wording.

24. Alfred can retrieve information through relationships.

25. Alfred can answer simple historical-state questions.

26. Alfred can supersede an outdated fact without losing the historical fact.

27. Alfred can distinguish explicit facts from inference.

28. Alfred can expose the source of a remembered answer.

29. User corrections change future answers appropriately.

30. User deletion removes private canonical records/artifacts as requested and regenerates affected indexes.

31. The SQLite/FTS structured index can be deleted and rebuilt without memory loss.

32. The vector index can be deleted and rebuilt without memory loss.

33. The graph index can be deleted and rebuilt without memory loss.

34. The reminder due-date index can be deleted and rebuilt without memory loss.

35. Integrity verification detects edited revision files, broken revision chains, and artifact hash mismatches.

36. Directory movement or storage reorganization does not change semantic relationships because the graph comes from `dref`s.

37. The system operates with at least one completely local model configuration.

38. No single external AI provider is required.

39. Alfred can canonicalize known public web identifiers such as YouTube videos, GitHub repositories, X posts, arXiv papers, and DOI-linked papers.

40. Alfred can create or consume public object records separately from public analysis records.

41. Alfred can represent multiple public analyses for the same public object without treating the first analysis as authoritative.

42. Alfred can maintain private interest records and match them against new public OIP records.

43. Daily Brief generation can include public discovery recommendations while clearly distinguishing them from private remembered facts.

44. Accepting a public discovery creates a private relationship record that `dref`s the public object or public analysis.

45. Dismissing a public discovery can update private ranking feedback without publishing private behavior.

46. Public metadata publication rejects private memories, private annotations, and wholesale copyrighted source copies by default.

47. Public discovery ranking includes trust, spam, freshness, and adversarial-content controls.

48. The query:

> "What was the wine we had at Sarah's?"

can return the correct wine even when those exact words never appeared together in the original stored source.

---

# 63. Product North Star

The system should eventually pass a very simple human test:

A user remembers **part of the context**.

Alfred remembers **the detail**.

The user should not need to remember how the information was stored, what document contained it, what words were originally used, which application captured it, or when they told Alfred.

They should be able to remember information the same imperfect way humans normally do:

> "What was that..."

> "Who was the person..."

> "Didn't somebody say..."

> "What did we use last time..."

> "Where was that place..."

> "What was the one at Sarah's..."

Alfred's job is to reconstruct the answer from the relationships between the fragments the user still remembers.

That is the core product requirement.

The goal is not a better search engine over personal data.

The goal is a **private, persistent, queryable model of the user's lived context**.
