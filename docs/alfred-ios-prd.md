# ALFRED iOS Client

## Product Requirements Document

**Status:** Draft v1  
**Product:** Alfred  
**Component:** iOS client  
**Depends on:** [Conversation Core PRD](./alfred-conversation-core-prd.md), [ALFRED MEMORY PRD](./ALFRED-MEMORY-prd.md), [alfrd.net desktop handoff](./alfrd-net-desktop-handoff.md)  
**Related external refs:** alfred-home `ios-alfrd-net-connectivity.md`, `alfrd-net-canonical-reference.md`

---

# 1. Executive Summary

Alfred on iOS is a first-class conversational client that connects to a user-owned Mac **desktop client** through **alfrd.net**, then participates in full voice and text conversation with Conversation Core while reading and writing the full OIP-local memory system.

The iOS app does **not** host Conversation Core policy or the canonical memory filesystem. Those remain on the desktop host. The phone is:

1. An **alfrd.net account + discovery client** (claim, LAN → WAN → relay)
2. A **LiveKit media participant** (microphone publish, assistant audio play, captions)
3. An **authenticated API client** for session control, memory, reminders, artifacts, and settings
4. A **capture surface** for photos, screenshots, documents, and share-sheet memory ingest

This split preserves the Conversation Core rule that LiveKit is transport only and policy lives in `@alfred/core`, and the Memory rule that filesystem packages on the user’s machine are the durable source of truth.

---

# 2. Product Vision

> Speak to Alfred from your phone the same way you would at your desk — and have every memory land in the same private store on your Mac.

The user should be able to:

- Claim their desktop client with an alfrd.net account and an 8-character claim secret
- Automatically use the best path home (LAN when nearby, WAN when reachable, relay otherwise)
- Hold a full duplex voice conversation with interruption, addendum, and caption behavior matching Conversation Core
- Explicitly or naturally store memories; photograph receipts and bottles; ask vague personal questions; correct and forget
- Receive due reminders and Daily Brief memory context without a second disconnected reminder database

---

# 3. Architecture Principles

## 3.1 Desktop is the authority

| Concern | Owner |
|---------|--------|
| Conversation FSM, response ledger, interruption arbiter, failover | Desktop `@alfred/core` + voice-agent |
| Canonical OIP memory packages, artifacts, indexes | Desktop `@alfred/memory` (`memory.oip-local`) |
| Persona (`SOUL.md` / `IDENTITY.md` / `USER.md`) | Desktop filesystem |
| Provider credentials (Deepgram, OpenAI, ElevenLabs, LiveKit) | Desktop `.env` / secret store |
| alfrd.net registration + outbound relay tunnel | Desktop `apps/desktop-client` |
| Mic capture, speaker playback, local UX, iOS permissions | iOS app |
| Cloud account JWT, claim, candidate discovery | iOS ↔ `api.alfrd.net` |

## 3.2 Connectivity is alfrd.net, not a hardcoded URL

Reuse the deployed control plane:

```text
ALFRD_CLOUD_URL=https://api.alfrd.net
ALFRD_RELAY_URL=wss://api.alfrd.net
```

Do not invent a second registry for Conversation Core.

## 3.3 Voice media is LiveKit; control APIs ride the discovered desktop URL

```text
iOS app
  ├── api.alfrd.net          auth, claim, candidates, relay status
  ├── {discoveredBaseUrl}    HTTP APIs (session, memory, pairing, LiveKit token)
  │     via LAN / WAN / https://api.alfrd.net/proxy/{desktopClientId}
  └── LiveKit Cloud (or self-hosted SFU)
        WebRTC mic ↑ / assistant audio ↓ / data-channel captions
```

Relay proxy requests that target the desktop must send:

```http
X-Cloud-Token: Bearer <cloudJwt>
```

so `Authorization` remains available for the future device bearer token.

## 3.4 One active long-term memory provider per profile

iOS must target the desktop’s active provider. For this product track, the canonical provider is **`memory.oip-local`**. The legacy `memory.local` JSONL provider may remain for migration/debug on the host but must not be the iOS-facing default once OIP HTTP APIs ship.

## 3.5 Privacy is architectural

Canonical memories stay on the user’s Mac filesystem. The phone may hold:

- Cloud JWT and device credentials in the Keychain / SecureStore
- Ephemeral session state and captions
- Optional local caches of retrieval answers and due reminders (never treated as canonical)

Private knowledge must not publish to public OIP by default. Any public-knowledge actions from iOS require explicit confirmation UI.

---

# 4. System Context (as implemented today)

### Desktop client (this repo)

- `pnpm desktop` → local Hono on `PORT` (default 3000)
- Registers with `api.alfrd.net`, advertises LAN/WAN/relay candidates
- Maintains outbound WebSocket relay tunnel
- Identity at `data/desktop-client/identity.json`
- Local endpoints today: `GET /connect/health`, `GET /connect/info`
- **Not yet shipped on desktop (required for this PRD):** device PIN pairing, Memory HTTP APIs, LiveKit token mint HTTP, conversation session HTTP, artifact upload

### Conversation Core (this repo)

- Cascaded voice path: Deepgram Flux → OpenAI → ElevenLabs over LiveKit
- Text simulator + FSM, response ledger, interruption arbiter
- Voice agent joins LiveKit as `alfred-agent`; browser client exists as reference media participant
- Memory retrieve/commit wired on voice path; `delegate_task` wired on text path first

### Memory (this repo)

- OIP-local packages, SHA-256 content-addressed artifacts, SQLite/FTS/graph indexes, hybrid retrieve, integrity verify/rebuild
- Extraction contract schema exists; full LLM extraction pipeline incomplete
- Vector index stubbed; reminders indexed on rebuild but lacking due/status HTTP APIs
- Public knowledge discovery not implemented (fields only)

The iOS PRD requires the desktop to expose the missing HTTP surface; iOS must not reimplement canonical storage.

---

# 5. Product Naming

| Term | Meaning |
|------|---------|
| Desktop client | Mac-hosted Alfred process (`pnpm desktop` + voice-agent / memory host) |
| Mobile client / iOS client | This app |
| Desktop Client ID | UUID shown in desktop logs / `/connect/info` (`desktopClientId`) |
| Control-plane `serverId` | Same UUID; do not rename remote API fields |
| Claim secret | 8-character secret required to claim the desktop |
| Discovered base URL | Winning LAN, WAN, or relay proxy URL stored on device |

---

# 6. Goals and Non-Goals

## 6.1 Goals

1. alfrd.net login/register, claim, multi-desktop select, LAN→WAN→relay discovery
2. Device pairing after discovery (PIN) with Keychain-stored device bearer
3. Full conversational voice + text against Conversation Core
4. iOS-correct audio session, permissions, background, interruption, and privacy disclosures
5. Full Memory MVP surface: remember, ask/search, correct, forget, artifacts, reminders, provenance, verify/rebuild (admin), Daily Brief due query
6. Share Sheet + Photos / Files ingest into content-addressed artifacts before acknowledgement
7. Connection status UX (LAN / WAN / relay / offline) with automatic rediscovery

## 6.2 Non-Goals (v1)

- Hosting Conversation Core or OIP packages on-device as canonical store
- On-device STT/LLM/TTS as the primary path (cloud providers remain desktop-side)
- Replacing LiveKit with a custom WebRTC stack
- Public OIP publication UI beyond approve/dismiss of desktop-surfaced discoveries (full publisher console later)
- Robot / computer-use control surfaces
- watchOS / CarPlay / widgets (design for later; not v1)
- Multi-user household ACL UI beyond respecting desktop `owner` / visibility fields

---

# 7. Recommended Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| App framework | Expo (Dev Client) + React Native | Matches alfred-home mobile direction; LiveKit RN SDK support |
| Navigation | Expo Router | Deep links for claim / share / reminders |
| Secure storage | `expo-secure-store` + Keychain | Cloud JWT, device token, discovered URL |
| Voice media | `livekit-react-native` | Same transport model as `apps/voice-client` |
| Audio session | `AVAudioSession` via LiveKit / expo-av helpers | PlayAndRecord, AEC, Bluetooth routes |
| Local network | Bonjour / Local Network usage string | LAN candidate probing |
| Capture | `expo-image-picker`, `expo-document-picker`, Share Extension | Memory artifacts |
| HTTP | Typed fetch clients (`cloud-api`, `desktop-api`) | Mirror handoff contracts |

If the team prefers native SwiftUI later, the **protocols and permission model in this PRD remain binding**; only the UI toolkit changes.

---

# 8. Connectivity Requirements

## 8.1 First-run / reconnect funnel

```text
Launch
  → Have cloud JWT?
       no  → Cloud login / register
       yes → Validate /auth/me
  → Have claimed desktopClientId?
       no  → Claim screen (Desktop Client ID + claim secret from Mac logs or /connect/info)
       yes → Load candidates
  → Discover LAN (10) → WAN (20) → relay (100)
  → Persist alfred_server_url
  → Device paired?
       no  → PIN pair against desktop
       yes → Home (Conversation + Memory)
```

## 8.2 SecureStore / Keychain keys

| Key | Content |
|-----|---------|
| `alfred_cloud_token` | JWT from `api.alfrd.net` |
| `alfred_cloud_server_id` | Claimed desktop client UUID (`serverId`) |
| `alfred_server_url` | Discovered best base URL |
| `alfred_device_token` | Local device bearer after PIN pairing |
| `alfred_device_id` | Device id after pairing |
| `alfred_profile_id` | Active Alfred profile (default `profile.default`) |

## 8.3 Control plane API (iOS → `api.alfrd.net`)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/auth/register` | Create account |
| `POST` | `/auth/login` | Login → JWT |
| `GET` | `/auth/me` | Session check |
| `POST` | `/auth/logout` | Logout |
| `POST` | `/servers/claim` | `{ serverId, claimSecret }` |
| `GET` | `/servers` | List claimed desktops |
| `GET` | `/servers/:id/candidates` | Refresh candidates |
| `DELETE` | `/servers/:id` | Unlink desktop |
| `GET` | `/relay/status/:serverId` | Online check |

## 8.4 Discovery rules

1. Sort candidates by ascending `priority`.
2. Probe `GET {url}/connect/health` with 5s timeout.
3. For **relay** candidates, attach `X-Cloud-Token: Bearer <cloudJwt>` (and any headers required by the deployed hub). Do not rely on LAN assumptions over cellular.
4. First healthy candidate wins; store base URL without trailing slash.
5. On API failures that look like path death (timeouts, connection errors, repeated 502 `relay_local_error`), trigger rediscovery once with backoff.
6. Surface connection mode in UI: `Local`, `Direct`, `Relay`, `Offline`.

## 8.5 Desktop prerequisites (must ship before or with iOS v1)

The desktop host must grow beyond `/connect/*`:

| Area | Endpoints (minimum) | Auth |
|------|---------------------|------|
| Pairing | `POST /pair/request`, `POST /pair/confirm`, `POST /pair/revoke` | claim-adjacent / PIN |
| Session | `POST /api/session/token` (LiveKit join), `GET /api/session/status`, `POST /api/session/end` | device bearer |
| Conversation (text) | `POST /api/conversation/turn`, `GET /api/conversation/events` (SSE or WS) | device bearer |
| Memory | Full set in §11 | device bearer + scopes |
| Health | existing `/connect/health` | none |

All of the above must be reachable identically over LAN, WAN, and `/proxy/:serverId/...` relay.

Device auth scopes (align with contracts):

```text
conversation.join
conversation.text
memory.read
memory.write
memory.admin
```

---

# 9. Conversation Requirements

## 9.1 Role of the iOS client in the voice stack

iOS is a LiveKit participant equivalent to `apps/voice-client`:

```text
iOS (mic WebRTC publish, PlayAndRecord)
        │  LiveKit room
        ▼
voice-agent on desktop (alfred-agent)
        │
        ▼
VoiceSessionController / Conversation Core
  STT → LLM → TTS (+ memory retrieve/commit)
        │
        ▼
assistant audio track + data-channel captions
        │
        ▼
iOS playback + transcript UI
```

iOS **must not**:

- Run its own STT→LLM→TTS policy that bypasses Conversation Core
- Treat LiveKit Agents `AgentSession` as the product state machine
- Commit long-term memory locally

## 9.2 Voice modes (product parity)

Support the same two modes Conversation Core defines:

1. **Cascaded** — desktop STT / LLM / TTS priority lists
2. **Unified** — locked speech-to-speech provider when desktop enables it

iOS exposes mode as a read-only or settings-forwarding control; authoritative config lives on desktop. When unified is active, UI must lock STT/LLM/TTS selectors and explain why.

## 9.3 Conversational behaviors the client must honor

| Behavior | Client responsibility |
|----------|----------------------|
| Listening / speaking state | Reflect desktop session state; show clear mic/speaking UI |
| Captions | Subscribe to data topics `alfred.caption` / `alfred.user` (or successor topics from desktop) |
| Barge-in | Keep publishing mic during assistant speech so desktop VAD/STT can detect interruption |
| Backchannel vs interruption | Do not locally decide; keep audio flowing; desktop arbiter owns policy |
| Late addendum | Allow user speech while generating; do not locally cancel the in-flight answer |
| Response ledger truth | Prefer desktop “delivered/heard” signals for UI “Alfred said…” history; local playout marks are hints only |
| Failover | Show non-blocking “switching provider…” when desktop emits failover events |
| `delegate_task` | Optional activity UI when desktop delegates; results return through conversation stream |

## 9.4 Text conversation

Provide a text thread that uses the same Conversation Core session (or a linked text session on the same profile) so memory commits and short-term context stay coherent with voice. Text is required for silent environments and as a fallback when mic permission is denied.

## 9.5 Session lifecycle

1. `POST /api/session/token` → `{ url, room, token, identity }`
2. Configure iOS audio session **before** connect
3. Connect LiveKit; enable microphone only after explicit user gesture (“Talk” / session start)
4. Publish mic track; subscribe to assistant audio
5. On background/foreground and route changes, renegotiate audio session; reconnect LiveKit with backoff
6. End session: disable mic, disconnect room, `POST /api/session/end`

## 9.6 Push-to-talk vs continuous listen

v1 ships **two user-selectable input modes**:

| Mode | Behavior | Default |
|------|----------|---------|
| Hold to talk | Mic enabled only while control is held / toggled on | Default on cellular / first launch |
| Continuous | Mic stays enabled for the active session (Conversation Core turn detection) | Opt-in; requires stronger privacy copy |

Continuous mode must show a persistent recording indicator (iOS system + in-app).

---

# 10. iOS Permissions, Audio, and Privacy

This section is normative. App Store review and Info.plist strings must match actual behavior.

## 10.1 Required permissions matrix

| Permission | When requested | Usage |
|------------|----------------|-------|
| **Microphone** (`NSMicrophoneUsageDescription`) | On first voice session start | Publish mic into LiveKit for Conversation Core |
| **Speech Recognition** (`NSSpeechRecognitionUsageDescription`) | Only if on-device dictation fallback is enabled | Optional; primary STT is desktop/cloud via LiveKit PCM — do **not** request Apple Speech solely for the cascaded path |
| **Local Network** (`NSLocalNetworkUsageDescription` + Bonjour services if used) | During discovery / Settings refresh | Probe LAN desktop candidate |
| **Photo Library** (`NSPhotoLibraryUsageDescription`) | On memory photo attach | Artifact ingest |
| **Camera** (`NSCameraUsageDescription`) | On “take photo for memory” | Artifact ingest |
| **Face ID / device passcode** | Optional app lock | Gate memory screens |
| **Background Modes → Audio** | If continuous session may play/record briefly in background | Keep LiveKit audio alive during short backgrounding |
| **Notifications** | Daily Brief / reminder surfacing | Local notifications scheduled from due-memory fetch |

Do **not** request Motion, Contacts, Precise Location, or Tracking for v1 conversation/memory unless a later feature needs them.

## 10.2 Audio session requirements

Configure an audio session equivalent to:

```text
category: PlayAndRecord
mode: VoiceChat (preferred) or VideoChat
options: AllowBluetooth, DefaultToSpeaker (user toggle), MixWithOthers off during session
```

Must handle:

- Phone call / FaceTime interruptions → pause session, typed cancel reason to desktop if connected
- Siri / alarm interruptions → same
- Bluetooth HFP vs A2DP route flips → rebuild tracks; show “Audio route changed”
- Wired headset plug/unplug
- Silent switch: voice product may still play assistant audio (document in UX); respect user mute control in-app
- Echo cancellation: rely on iOS VoiceChat AEC + desktop `SelfVoiceGate` / echo filters; default to earpiece or headset when available; speakerphone mode must be explicit

## 10.3 Background and lock screen

| State | Required behavior |
|-------|-------------------|
| App foreground, session active | Full duplex |
| Brief background (< ~30s), session active | Attempt to keep audio session; if OS suspends sockets, auto-reconnect on foreground |
| Extended background | End or suspend continuous listen; allow local notification for due reminders |
| Lock screen | Optional Now Playing / CallKit-like presentation is **not** required in v1; if continuous audio continues, show system recording indicator |

True always-on hotword wake is out of scope for v1.

## 10.4 Privacy disclosures (in-app + privacy nutrition labels)

Disclose that during a voice session, microphone audio is sent to:

1. LiveKit (media transport)
2. Desktop host
3. User-configured STT / LLM / TTS providers (e.g. Deepgram, OpenAI, ElevenLabs)

Disclose that memory artifacts (photos, documents, transcripts) are stored on the user’s desktop filesystem and may be sent to user-approved models for extraction when the desktop privacy mode is Private Hybrid.

Provide a Settings screen that surfaces desktop privacy mode: **Local Only** / **Private Hybrid** / **User Managed** (read from desktop; cannot silently escalate from the phone).

## 10.5 Network security

- ATS: allow local HTTP LAN candidates (`NSAllowsLocalNetworking`); WAN/relay should be HTTPS
- Never log claim secrets, cloud JWTs, or device tokens
- Clear credentials on logout / unpair
- Pasteboard claim secret entry should warn about shoulder surfing

---

# 11. Memory Requirements (Full Implementation Surface)

iOS implements the **client** for the Memory PRD MVP. Canonical behavior is defined in [ALFRED-MEMORY-prd.md](./ALFRED-MEMORY-prd.md); this section specifies mobile UX and the desktop HTTP contract iOS depends on.

## 11.1 Invariants the app must preserve

1. Acknowledge successful capture only after the desktop confirms durable artifact or raw input persistence.
2. Corrections create new revisions; never imply history was rewritten.
3. New experiences create new memories; preference changes do not erase old episodes.
4. Show confidence language: remembered / likely / ambiguous / inferred / unknown.
5. Deletion requests must offer scopes: artifact only / extracted memory / entity / episode / connected subgraph.
6. Public discovery cards are recommendations, never “Alfred remembers this about you,” until the user saves.

## 11.2 Desktop Memory HTTP API (iOS contract)

All paths are relative to the discovered desktop base URL. Auth: device bearer; relay adds `X-Cloud-Token`.

### Core

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/memory` | Add memory (text and/or multipart artifact) |
| `POST` | `/api/memory/search` | Hybrid search without answer generation |
| `POST` | `/api/memory/ask` | Query interpretation + hybrid retrieval + answer |
| `POST` | `/api/memory/correct` | Correction observation + revision/supersession |
| `DELETE` | `/api/memory/:id` | Forget / delete with scope query params |
| `GET` | `/api/memory/entity/:id` | Entity package current revision |
| `GET` | `/api/memory/episode/:id` | Episode package |
| `GET` | `/api/memory/assertion/:id/provenance` | Provenance chain |
| `POST` | `/api/memory/verify` | Integrity verification |
| `POST` | `/api/memory/rebuild-indexes` | Rebuild disposable indexes |

### Reminders / Daily Brief

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/memory/due` | Due/overdue reminders for date + timezone |
| `POST` | `/api/memory/:id/reminder/surfaced` | Mark surfaced |
| `POST` | `/api/memory/:id/reminder/status` | `completed` / `dismissed` / `snoozed` |

### Public knowledge (MVP client)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/public-knowledge/index` | Index public URL |
| `POST` | `/api/public-knowledge/discover` | Interest-matched candidates |
| `POST` | `/api/memory/link-public` | Save privately after approval |
| `POST` | `/api/public-knowledge/publish` | Only with explicit confirm; reject private payloads |

### Conversational memory bridge

Voice/text turns continue to use desktop `retrieve` / `commitTurn` inside Conversation Core. iOS additionally exposes explicit UI actions that call the HTTP APIs above so users can manage memory without speaking.

## 11.3 Capture → ingest UX

Supported inputs on iOS:

| Input | UI | Desktop handling |
|-------|----|------------------|
| Spoken “remember…” | Voice session | Core commitTurn + extraction |
| Typed note | Compose sheet → `POST /api/memory` | Package + indexes |
| Camera photo | Camera → upload bytes | Content-addressed artifact first |
| Photo library | Picker → upload | Same |
| Files / PDF | Document picker | Same |
| Share Extension | Share to Alfred | Background upload when desktop reachable; otherwise durable local outbox |

**Share Extension / offline outbox:** queue encrypted payloads on device; flush when discovery succeeds; never claim “Remembered” until desktop ack.

## 11.4 Memory screens (v1)

1. **Ask Memory** — natural language ask; show answer + explainability path (entity → episode → assertion → artifact)
2. **Recent / Search** — hybrid search results with type chips (Person, Place, Episode, …)
3. **Entity / Episode detail** — current revision summary, drefs, provenance, reminder fields
4. **Capture** — camera / files / note
5. **Reminders** — due today + overdue; complete / dismiss / snooze; date-only vs timestamp preserved in UI
6. **Daily Brief** — private reminders + public discovery recommendations (clearly labeled)
7. **Corrections** — “That’s not right” flow with candidate selection when ambiguous
8. **Settings → Memory** — active provider, verify, rebuild indexes (admin scope), privacy mode

## 11.5 Reference scenarios (acceptance)

iOS + desktop together must pass Memory PRD reference scenarios from the phone:

1. Wine at Sarah’s (photo + voice/text) → later ask from phone
2. Changing household filter fact → current vs historical answers
3. Mike recommends Chez Panisse → fuzzy relational ask
4. HVAC invoice photo → “what did they say we’d need to replace?”
5. “Remind me to call Sarah on August 15” (date-only) → appears in due list / Daily Brief
6. Correction: “That wasn’t at Sarah’s; it was at Mike’s.” → future answers change; history retained
7. Forget artifact but keep summary — scoped delete

## 11.6 Extraction honesty

Until desktop LLM extraction is fully wired, iOS must:

- Still capture artifacts and observations durably
- Show processing states: `stored`, `extracting`, `indexed`, `needs_resolution`
- Surface ambiguities returned by the extraction contract (`needsResolution`) for user resolution UI

Do not fake rich graph extraction in the client.

---

# 12. Application Information Architecture

```text
Onboarding
  CloudLogin → ClaimDesktop → Discovering → PairDevice → PermissionPrimer

Main tabs
  Talk          Voice + text conversation
  Memory        Ask / search / capture / detail
  Brief         Daily Brief + reminders
  Settings      Desktops, connection mode, audio, privacy, pairing
```

### Talk

- Primary brand-forward conversation surface
- Large push-to-talk / session control
- Live captions
- Compact connection pill (Local / Direct / Relay)

### Memory

- Ask field hero
- Capture FAB (photo / file / note)
- Recent answers and saved entities

### Brief

- Due reminders with memory context
- Public discovery cards with Save / Dismiss

### Settings

- Account (alfrd.net)
- Desktop clients (claim, switch, unlink)
- Rediscover connection
- Audio route defaults, continuous vs hold-to-talk
- Privacy mode (read-only from desktop)
- Sign out / unpair

---

# 13. Desktop Host Work Required by This PRD

iOS cannot ship full conversation + memory against today’s desktop-only `/connect/*` surface. Track these host milestones as dependencies:

| ID | Host work | Blocks |
|----|-----------|--------|
| H0 | Claim QR page (`/connect/claim`) + `alfred://claim` URI | Faster phone claim (manual secret still required as fallback) — **shipped** |
| H1 | Device PIN pairing + device bearer middleware | All authenticated APIs |
| H2 | `POST /api/session/token` (+ status/end) wired to LiveKit mint | Voice |
| H3 | Mount Memory HTTP API on desktop host over `OipLocalMemoryProvider` | Memory tabs |
| H4 | Multipart artifact upload → `putArtifactBytes` before ack | Photo/file remember |
| H5 | Reminder due/status endpoints over rebuildable reminder index | Brief tab |
| H6 | Conversation text turn + event stream | Text chat parity |
| H7 | Switch voice default active provider to `memory.oip-local` (or profile setting) | Unified memory |
| H8 | Session event bridge (failover, delegation, ledger delivery marks) to clients | Advanced Talk UI |

Relay compatibility test: every new route must pass `curl` through `/proxy/{id}/...` with `X-Cloud-Token`.

---

# 14. Implementation Phases

## Phase 0 — Connectivity skeleton

- Expo app shell, SecureStore keys, cloud-api, discovery, claim UI
- Health probe LAN/WAN/relay against existing desktop client
- Connection status + rediscovery
- **Exit:** Claim Mac desktop from phone; `/connect/health` succeeds on best path

## Phase 1 — Pairing + session token

- PIN pairing against H1
- LiveKit token fetch + room connect with mic muted until gesture
- Permission primer (Mic + Local Network)
- **Exit:** Hear a test tone / agent presence in room

## Phase 2 — Full voice conversation

- Hold-to-talk and continuous modes
- Captions, route changes, call interruptions
- Align with Conversation Core barge-in / addendum (no local policy fork)
- Text fallback thread (H6)
- **Exit:** Multi-turn voice chat with interruptions behaves like desktop browser client

## Phase 3 — Memory MVP client

- Ask / search / add text memory
- Photo + file artifact upload with durable-ack rule
- Entity/episode detail + provenance
- Correct + forget flows
- **Exit:** Memory PRD scenarios 1–4 operable from phone

## Phase 4 — Reminders + Daily Brief

- Due query using device timezone
- Complete / dismiss / snooze
- Local notifications for due items when app is backgrounded
- Public discovery save/dismiss cards when desktop supports H3 public endpoints
- **Exit:** Date-only reminder survives missed brief; wine/reminder scenarios pass

## Phase 5 — Hardening

- Offline outbox for Share Extension
- Integrity verify / rebuild admin actions
- Telemetry (connection mode success rates, session drop causes) without private memory contents
- App Store privacy nutrition + review notes
- **Exit:** TestFlight release candidate

---

# 15. Acceptance Criteria

### Connectivity

1. User can register/login to alfrd.net from iOS.
2. User can claim a desktop client using Desktop Client ID + claim secret from `pnpm desktop` logs or `/connect/info`.
3. Discovery prefers LAN when healthy, else WAN, else relay.
4. Relay calls succeed with `X-Cloud-Token` and continue to work when `Authorization` carries the device token.
5. Rediscovery recovers from desktop sleep/wake and network changes.
6. Multiple claimed desktops can be switched; active selection persists.

### Conversation

7. User can start a voice session only after mic permission grant + explicit gesture.
8. Assistant audio plays with VoiceChat AEC; speakerphone is opt-in.
9. Captions for user and assistant render with acceptable latency.
10. User barge-in stops or arbitrates assistant speech per desktop policy (client does not invent a second policy).
11. Late speech during generation produces addendum behavior rather than client-side cancel of the first answer.
12. Text conversation shares profile memory with voice.
13. Phone call interruption pauses cleanly and can resume.
14. Continuous listen shows system + in-app recording indicators.
15. Denial of mic still allows text + memory features.

### Memory

16. Explicit “remember” from phone persists into OIP-local packages on the Mac.
17. Artifact bytes are content-addressed on desktop before success UI.
18. Ask Memory answers vague queries using hybrid retrieval (not keyword-only UI tricks).
19. Provenance is viewable for nontrivial answers.
20. Corrections append revisions; historical episodes remain.
21. Scoped forget removes what the user asked and rebuilds indexes as needed.
22. Reminders preserve date-only vs timestamp; due/overdue appear in Brief.
23. Reminder status changes do not mutate historical revision files.
24. Public discovery save creates a private relationship `dref`; dismiss does not publish behavior.
25. App never presents public recommendations as private remembered facts.
26. Share Extension items eventually sync without double-ack lying about durability.
27. Verify/rebuild admin actions are available to authorized devices.

### Permissions / compliance

28. Info.plist strings accurately describe each permission.
29. No permission is requested before its feature is used (except documented primer screen that explains upcoming requests).
30. Privacy labels match LiveKit + provider data flows.
31. Secrets never appear in analytics or crash logs.

---

# 16. Test Plan

## 16.1 Connectivity

- Claim flow unit tests against mocked `api.alfrd.net`
- Discovery ordering tests (LAN fail → WAN → relay)
- Physical matrix: same Wi-Fi, cellular + home WAN, cellular + relay-only, desktop offline

## 16.2 Conversation

- Join room, publish 16 kHz-compatible mic, receive assistant PCM
- Barge-in while speaking
- Addendum while generating (desktop simulator parity)
- Audio interruption injection (call)
- Bluetooth route flip mid-session

## 16.3 Memory

- Run Memory PRD scenarios 1–4 and reminder scenario through device → relay → desktop
- Artifact dedupe: upload same photo twice → one content hash
- Airplane mode capture → outbox → flush → single package
- Ambiguous entity resolution UI when desktop returns `needsResolution`

## 16.4 Regression hooks

Desktop `pnpm simulate` and `packages/memory` OIP tests remain green; iOS adds contract tests against recorded HTTP fixtures for `/api/memory*` and `/api/session/token`.

---

# 17. Open Questions

1. **App packaging:** Expo Dev Client vs pure native SwiftUI for v1 shipping?
2. **LiveKit account:** reuse desktop LiveKit project exclusively (preferred) vs separate mobile project?
3. **Pairing UX:** numeric PIN on desktop terminal vs QR containing `serverId` + short-lived pair code?
4. **Profile selection:** single `profile.default` only for v1, or multi-profile switcher?
5. **CallKit:** worth it for continuous sessions in v1.1?
6. **BLAKE3 vs SHA-256:** memory store currently hashes with SHA-256; iOS should treat algorithm tags as opaque and not assume BLAKE3 until desktop migrates.

---

# 18. Key Decisions

1. iOS is a client; desktop remains Conversation Core + Memory authority.
2. Connectivity uses existing alfrd.net control plane and desktop relay tunnel.
3. Voice media uses LiveKit; conversation policy stays in `@alfred/core`.
4. Memory UI speaks the Memory PRD HTTP surface over the discovered desktop URL.
5. Durable ack only after desktop persistence — especially for artifacts.
6. Relay auth uses `X-Cloud-Token` for the cloud JWT; device bearer uses `Authorization`.
7. Hold-to-talk is default; continuous listen is opt-in with stronger indicators.
8. Apple Speech permission is not required for the primary cascaded voice path.
9. Canonical provider for this track is `memory.oip-local`.
10. Public knowledge can flow inward as recommendations; private knowledge never publishes from iOS without explicit confirmation.

---

# 19. Document Map

| Doc | Role |
|-----|------|
| [alfred-conversation-core-prd.md](./alfred-conversation-core-prd.md) | Conversational policy requirements |
| [ALFRED-MEMORY-prd.md](./ALFRED-MEMORY-prd.md) | Canonical memory model and APIs |
| [alfrd-net-desktop-handoff.md](./alfrd-net-desktop-handoff.md) | Desktop registration, claim, discovery, relay |
| This document | iOS product + permissions + client contracts |

North star: the phone is how you talk to Alfred and capture life; the Mac is where Alfred thinks and remembers.
