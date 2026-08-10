# Multi-Desktop Memory Sync

**Status:** Future work — design notes only  
**Related:** [ALFRED-MEMORY-prd.md](./ALFRED-MEMORY-prd.md), [alfrd-net-desktop-handoff.md](./alfrd-net-desktop-handoff.md), [ios-desktop-pairing.md](./ios-desktop-pairing.md)

---

## 1. Current state

alfrd-net connectivity does **not** sync memory between machines.

What exists today:

- Each desktop client has its own `desktopClientId`, claim secret, and local filesystem memory store
- A cloud account can **claim multiple** desktop clients
- Mobile (or another client) can **discover and talk to one** chosen desktop via LAN → WAN → relay
- Memory remains local to that host

What does **not** exist:

- Desktop ↔ desktop pairing for shared memory
- Package/artifact replication
- Conflict resolution between two writers
- A shared “household memory” identity spanning Macs

Claiming two desktops under one alfrd.net account only means both appear in the server list. Their memory corpora stay independent.

---

## 2. Product intent

Run Alfred conversations on **two (or more) Macs**. Each machine should:

1. **Capture** new memories from local conversation / ingest
2. **Retrieve** memories that were originally captured on either machine
3. Stay **local-first** — cloud is transport/coordination, not the canonical store

Conflicts are expected to be rare because:

- New logical memories use non-content-derived IDs (ULID / UUID), so parallel creates usually do not collide
- Content-addressed artifacts / revision hashes make identical bytes converge naturally
- Corrections already append revisions rather than mutating history

When the same logical memory **does** diverge on two machines: **keep both versions** as distinct revisions, each with its own timestamp (valid/knowledge time as appropriate). Do not silently drop either side.

---

## 3. Recommended sync model: multi-writer peers

Given the intent above, prefer **multi-writer peer sync** over primary/replica.

| Model | Fit for this intent |
|-------|---------------------|
| **Primary / replica** | Poor — only one Mac can safely capture; the other is read-mostly |
| **Shared folder (Syncthing / iCloud)** | Possible shortcut, but file-level conflicts and no Alfred-aware revision merge |
| **Multi-writer peer sync** | **Recommended** — both Macs capture and retrieve; sync exchanges canonical packages + artifacts |

### How it should work conceptually

```text
Mac A                          Mac B
  │                              │
  │  conversations → packages    │  conversations → packages
  │  artifacts (blake3)          │  artifacts (blake3)
  │                              │
  └──── sync protocol ───────────┘
         (LAN preferred,
          alfrd.net relay OK)

Canonical truth on each Mac after sync:
  union of packages + artifacts
  indexes rebuilt locally
```

- **Canonical sync unit:** filesystem memory packages + content-addressed artifacts (not SQLite/vector indexes)
- **Indexes:** disposable; rebuild after apply on each peer ([Memory PRD](./ALFRED-MEMORY-prd.md) §34)
- **Transport:** reuse alfrd-net where useful (one peer can call the other’s HTTP API over LAN or relay). Sync is an application protocol on top of connectivity, not a property of claim/discovery alone
- **Topology (MVP):** pair two desktops explicitly (A ↔ B). Mesh of N can come later as pairwise or hub-and-spoke among claimed household machines

### Why not rely on hashes alone

Hashes prevent accidental overwrite of *identical* content and make artifact dedupe easy. They do **not** define merge policy when two peers append different heads for the same logical ID. That policy must be explicit — see §4.

---

## 4. Conflict policy (decided direction)

**Rule:** when two peers disagree about a logical memory, **include both versions as different revisions**, each retaining its own timestamp metadata.

Sketch:

```text
Mac A head:  did:memory:X @ blake3:aaa  (learnedAt T1)
Mac B head:  did:memory:X @ blake3:bbb  (learnedAt T2)

After sync on both:
  revision chain contains both aaa and bbb
  neither is discarded
  manifest currentRevision = newer by agreed ordering
    (prefer learnedAt / updatedAt; tie-break by revision hash)
  retrieval / UI can still surface that two concurrent edits existed
```

Implementation notes to revisit later:

1. **New memories (different logical IDs)** — no conflict; union merge
2. **Same artifact bytes** — store once by content hash; both packages `dref` it
3. **Same logical ID, divergent revision heads** — import missing revisions from the peer; if histories forked, record both branches (or linearize by timestamp while preserving both revision files and a `concurrentWith` / merge provenance link)
4. **Same logical ID, identical head hash** — already in sync
5. **Deletes / forget** — need an explicit tombstone sync rule (out of scope until forget lands consistently)

Do **not** use “last writer wins and deletes the other revision.” That violates the stated intent.

---

## 5. What would need to be built

Rough work packages when we pick this up:

### 5.1 Pairing / trust between desktops

- Explicit “link this Mac to another desktop client” flow (not the same as mobile PIN, but can share device-token ideas)
- Mutual auth so sync endpoints are not open merely because `/connect/info` is unauthenticated
- Persist peer desktop client IDs + sync credentials under `data/desktop-client/` (or similar)

### 5.2 Sync protocol (HTTP on the desktop client)

Minimum conceptual API surface:

| Capability | Purpose |
|------------|---------|
| Advertise clock / cursor / package inventory | What changed since last sync |
| List packages + manifest heads | Cheap diff |
| Pull package revisions + manifests | Bring peer up to date |
| Pull artifacts by content hash | Fill missing blobs |
| Push or bidirectional exchange | Both sides capture |
| Ack / sync report | Diagnostics, partial failure |

LAN-first; fall back through `api.alfrd.net` relay when peers are remote (same candidate discovery story as mobile).

### 5.3 Merge engine

- Apply remote packages into the local canonical store without rewriting existing revision files
- Union revision sets; apply §4 when heads diverge
- Rebuild indexes after a successful apply
- Integrity verify hashes after sync ([Memory PRD](./ALFRED-MEMORY-prd.md) §34.4)

### 5.4 Runtime behavior

- Background sync on an interval + on idle after local writes
- Manual “Sync now” in desktop UI
- Clear status: last success, peer online/offline, conflicts kept as dual revisions

### 5.5 Non-goals for first sync MVP

- Automatic pairing of every claimed desktop without user consent
- Using the control plane SQLite as a memory mirror
- Syncing rebuildable indexes as source of truth
- Perfect real-time CRDT for every field (revision-union is enough for MVP)

---

## 6. Relationship to alfrd-net and iOS

| Layer | Role |
|-------|------|
| **alfrd.net claim + relay** | Find and reach a desktop; optional transport for peer sync when not on LAN |
| **iOS pairing** | Phone talks to **one** desktop’s APIs; does not replace desktop↔desktop sync |
| **Multi-desktop sync** | Keeps Mac A and Mac B’s canonical memory stores converging |

If iOS always targets a single “active” desktop, sync between Macs still matters so either Mac can be that active host without missing memories.

---

## 7. Open questions for later

1. **Ordering key** for “current” head when both revisions are kept: `learnedAt` vs `updatedAt` vs sync receive time?
2. **Three+ machines:** full mesh vs one elected sync hub among household desktops?
3. **Partial sync / bandwidth:** artifact lazy-fetch vs eager full mirror?
4. **Encryption at rest on the wire** beyond TLS on relay — extra envelope for peer payloads?
5. **Shared household vs per-user memory** visibility once multi-user lands (Memory PRD §40)

---

## 8. One-line summary

**Not supported today.** When built: multi-writer peer sync of canonical filesystem packages over LAN/relay, with divergent edits preserved as separate timestamped revisions rather than dropped.
