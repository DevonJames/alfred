# Audio notes — pipeline, APIs, and folder ingest

**Audience:** An agent ingesting a folder of already-recorded audio files into Alfred, one file at a time.  
**Runtime:** The Mac desktop (`pnpm desktop` or `make alfred`) on `http://127.0.0.1:3000`.  
**Source of truth:** this repo. Do not call alexandria.io, alfred-home notes, or OpenClaw.

This document is the contract for voice notes. Phone recording, relay upload, STT, summarization, and OIP memory all land in the same Episode shape. Folder ingest should use that same path — not a parallel importer.

---

## 0. What this is (and is not)

Alfred audio notes are **recordings that become memory**, not a chat app.

| In scope | Out of scope |
|---|---|
| Short vs long recordings (long = async STT + summarize) | alfred-notes-iOS agent chat / RAG |
| Transcript + structured metadata | Live dependency on alfred-home |
| Persist in OIP memory (`packages/memory`) | `POST /api/memory` from the phone for the same note |
| Original audio attached like a photo/PDF | On-device STT |
| Notes tab on desktop (`/notes`) and iOS | Importing old alexandria/GUN notes |

Canonical metadata written onto the Episode and into Observations:

```json
{
  "summary": "2–3 sentence executive summary",
  "takeaways": ["..."],
  "nextSteps": [{ "text": "...", "assignee": "...", "dueDate": "YYYY-MM-DD" }],
  "openQuestions": ["..."],
  "attendees": ["..."],
  "template": "meeting | brainstorm | checkin | freeform"
}
```

`dueDate` values that parse as `YYYY-MM-DD` also write `remindAt` on the action Observation.

Templates: `meeting` | `brainstorm` | `checkin` | `freeform`.

---

## 1. Architecture (do not mix these stacks)

| Stack | Role |
|---|---|
| **This repo, desktop** | Notes **server**. STT, summarize, OIP writes, `/notes` UI, `/api/notes` for the phone. |
| **This repo, iOS** | Recorder + Notes tab. Talks to the Mac via device token (LAN or alfrd.net relay). |
| `alfred-notes-iOS/` (if present) | Old Expo app against alexandria.io. **Do not use.** |
| `alfred-home` | Historical short/long notes + ffmpeg split. **Copied patterns only** — not a runtime dependency. |

The phone never writes memory for a note. The Mac does one ingest at the end of STT + summarize.

---

## 2. End-to-end pipeline

```
audio bytes
    │
    ├─ iOS Long / relay  → chunked upload (256 KB) → assemble on Mac
    ├─ iOS Short + LAN ≤8 MB → one multipart POST
    └─ Mac / agent folder ingest → POST /notes/from-audio-async  ★ use this
    │
    ▼
beginAudioNote()
    Artifact (MediaObject, audio/*)
    Entity AudioObject  ← drefs.sourceArtifact
    Episode Event       ← drefs.sourceArtifact + recording; processingStatus=processing
    │
    ▼
processNoteJob()          [always force-chunks STT]
    ffmpeg → 5-min 16 kHz mono WAV
    STT: VOICE_STT_URL → gpt-4o-transcribe → whisper-1
    updateAudioNoteProgress() after each chunk
    │
    ▼
summarizeAudioNote()      Grok/xAI, else OpenAI; map-reduce if transcript is long
    │
    ▼
completeAudioNote()
    Episode schema: summary, takeaways, nextSteps, openQuestions, attendees, template, transcript
    Observations: summary, takeaways, actions (remindAt), questions, transcript chunks
    rebuildIndexes()
    processingStatus=completed
```

**Short vs long**

| Mode | Who | What happens |
|---|---|---|
| Short | iOS on LAN, file ≤ 8 MB | `POST /api/notes/from-audio` — **sync** STT + summarize in the request. Does **not** force ffmpeg chunking. Bad for anything over ~8 minutes or 20 MB. |
| Long | iOS default; auto-flips at 50 min | `POST /api/notes/from-audio-async` or chunked upload `complete` → `queueNoteFromAudio` → background job. **Always** `forceChunk: true`. |
| Folder ingest | Agent on the Mac | Always use the **async** path. Treat every file as long. |

iPhone capture (for context, not folder ingest): AAC `.m4a`, 44.1 kHz stereo, 128 kbps ≈ **55–60 MB per hour**. Stored on the phone until upload finishes; the Mac keeps the canonical copy.

---

## 3. OIP graph (what “saved in memory” means)

Provenance on every note record: `sourceType: "audio_note"`.

```
Artifact (bytes on disk, contentHash)
    ↑ drefs.sourceArtifact
Entity AudioObject          alfred.entityClass = audio_note_file
    ↑ drefs.sourceArtifact + drefs.recording
Episode Event               the note; schema holds metadata + processingStatus
    ↑ drefs.isPartOf + drefs.sourceArtifact
Observations
    audio_note_summary
    audio_note_takeaway
    audio_note_action          (+ remindAt when dueDate is YYYY-MM-DD)
    audio_note_question
    audio_note_transcript      (~2200 char chunks)
```

Graph preview follows `drefs.sourceArtifact` and plays `kind: "audio"` (`<audio controls>` on desktop). Retrieval tags notes as `source=audio note`.

Do **not** also call `commitTurn` or `POST /api/memory` for the same recording. One `beginAudioNote` / `completeAudioNote` (or `ingestAudioNote`) is the write.

---

## 4. Prerequisites (desktop must already be running)

Folder ingest assumes the same machine the user uses for Talk:

1. Desktop listening on `http://127.0.0.1:3000` (`make alfred` or `pnpm desktop`).
2. `ffmpeg` and `ffprobe` on `PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`). Without ffmpeg, a long file is sent whole to OpenAI and fails the 25 MB cap.
3. STT: `VOICE_STT_URL` (local whisper) and/or `OPENAI_API_KEY`.
4. Summaries: `GROK_API_KEY` or `XAI_API_KEY` preferred, else `OPENAI_API_KEY`.
5. Mac awake until each job’s `processingStatus` is `completed` or `failed`. A 2-hour file can take 30–90+ minutes of STT.
6. Desktop HTTP timeouts are 3 hours. Jobs persist in `{oipRoot}/indexes/audio-note-jobs.json` and resume on boot — but resume **restarts STT from chunk 1**.

Boot also: `loadNoteJobs()` → `resumeInterruptedNoteJobs()`, `pruneStaleNoteUploads()`, `resumeAssemblingNoteUploads()`, ffmpeg/key warnings.

Default OIP root: `data/memory-oip/profile.default` (override `ALFRED_MEMORY_OIP_PATH`).

---

## 5. How another agent should ingest a folder

**Do this on the Mac, against localhost `/notes` (no device token).**  
**One file at a time. Wait until that note is `completed` or `failed` before starting the next.**

Do not use the chunked `/api/notes/uploads*` flow for files already on disk. That exists for the phone over alfrd.net (30s JSON-relay hops). Do not use `ingestAudioNote()` unless you already have a transcript — it skips STT.

### 5.1 Supported files

Anything `audioMimeFromFilename` understands:

`.m4a` / `.aac` → `audio/mp4` · `.mp3` → `audio/mpeg` · `.wav` → `audio/wav` · `.webm` · `.ogg` · `.flac` · `.caf`

Field name in the form: `audio` or `file`. Max practical size: a few hundred MB; chunked-upload cap is 300 MB if you ever go through `/api/notes/uploads`.

### 5.2 POST one file (async — required)

```http
POST http://127.0.0.1:3000/notes/from-audio-async
Content-Type: multipart/form-data
```

| Field | Required | Notes |
|---|---|---|
| `audio` or `file` | yes | The recording bytes. Filename on the part becomes `originalFilename`. |
| `title` | no | Else: filename stem, later replaced by summary prefix when the job finishes. |
| `template` | no | `meeting` \| `brainstorm` \| `checkin` \| `freeform` (default). |
| `attendees` | no | JSON array of strings, or comma-separated names. |
| `durationSeconds` | no | Number. Else ffprobe. |

Example:

```bash
curl -sS -X POST http://127.0.0.1:3000/notes/from-audio-async \
  -F "audio=@/path/to/folder/rental-tour.m4a;type=audio/mp4" \
  -F "title=Rental tour" \
  -F "template=meeting" \
  -F "attendees=[\"Devon\",\"Landlord\"]"
```

**202-equivalent success body** (HTTP 200):

```json
{
  "job": {
    "id": "<job-uuid>",
    "noteId": "<episode-id>",
    "status": "queued",
    "progress": 0,
    "message": "Queued",
    "error": null,
    "createdAt": "...",
    "updatedAt": "..."
  },
  "note": {
    "id": "<episode-id>",
    "title": "Rental tour",
    "template": "meeting",
    "processingStatus": "processing",
    "summary": "",
    "takeaways": [],
    "nextSteps": [],
    "openQuestions": [],
    "attendees": [{ "name": "Devon" }, { "name": "Landlord" }],
    "transcript": "",
    "audioUrl": "/api/notes/<episode-id>/audio",
    "artifactId": "...",
    "fileEntityId": "...",
    "episodeId": "<episode-id>",
    "durationSeconds": 4732,
    "createdAt": "...",
    "updatedAt": "...",
    "jobId": "<job-uuid>",
    "job": { "...same job..." }
  }
}
```

The Episode and audio Artifact exist **immediately**. STT has not finished. Save `note.id` and `job.id`.

### 5.3 Poll until done (required before the next file)

Prefer the note, not only the job — the UI and memory graph key off Episode `processingStatus`.

```bash
curl -sS http://127.0.0.1:3000/notes/<episode-id>
curl -sS http://127.0.0.1:3000/notes/jobs/<job-id>
```

Stop when:

| `note.processingStatus` | `job.status` | Meaning |
|---|---|---|
| `completed` | `completed` | Transcript + metadata + Observations written. **Next file.** |
| `failed` | `failed` | See `job.error`. You may `POST /notes/<id>/retry-transcript`. Do not silently skip. |
| `processing` | `queued` / `processing` | Wait. Poll every 4–10s. `job.message` + `job.progress` (0–100) are human-readable. |

A long rental often sits at “Transcribed chunk N of M” for a long time. That is success-in-progress.

### 5.4 Folder loop (pseudocode)

```
desktop must already be up on :3000
for each audio file in folder (stable sort: name or mtime):
  POST /notes/from-audio-async with that file
  if HTTP not 2xx: stop and report
  episodeId = body.note.id
  loop:
    GET /notes/{episodeId}
    if processingStatus == completed: break
    if processingStatus == failed: record error; break (or retry-transcript once)
    sleep 5s
  append { file, episodeId, status } to a manifest
  only then start the next file
```

Do **not** fire all POSTs at once. Jobs can run concurrently in process (`runningJobs` is per job id), which will fight ffmpeg/CPU and OpenAI rate limits.

### 5.5 Optional: title / template from the filename

There is no folder-manifest schema. If the user did not specify mapping, a reasonable default is:

- `title` = filename without extension
- `template` = `freeform` unless the path or a sidecar JSON says otherwise
- `attendees` omitted

If a sidecar `{basename}.json` exists next to the audio, honor `title`, `template`, `attendees`, `durationSeconds` from it.

### 5.6 In-process alternative (same machine, this repo)

If you are writing a script inside this monorepo instead of curling:

```ts
import { readFile } from "node:fs/promises";
import { queueNoteFromAudio, getAudioNote } from "./apps/desktop-client/src/lib/notes/service.js";

const bytes = await readFile("/path/to/file.m4a");
const { job, note } = await queueNoteFromAudio({
  bytes,
  filename: "file.m4a",
  mimeType: "audio/mp4",
  title: "Rental tour",
  template: "meeting",
  attendees: ["Devon"],
});
// poll getAudioNote(note.id) until processingStatus is completed | failed
```

This only works **in the already-running desktop process** (same OIP provider cache, same in-memory `jobs` map). A second Node process will not see live jobs. Prefer HTTP.

`createNoteFromAudio()` is the sync/short path. Do not use it for a folder of unknown-length files.

`ingestAudioNote()` in `@alfred/memory` is **store + write Observations** given an existing transcript. Use it only if STT already happened.

### 5.7 Verify a finished note

```bash
curl -sS http://127.0.0.1:3000/notes/<episode-id>
# note.transcript non-empty
# note.summary non-empty (unless both LLM keys failed — then empty fallback)
# GET http://127.0.0.1:3000/notes/<episode-id>/audio  → audio bytes
```

Desktop UI: `http://127.0.0.1:3000/notes` (Notes tab in the shell). Memory graph: `http://127.0.0.1:3000/memory/graph` — select the Episode or Artifact and play.

Retries:

```bash
curl -sS -X POST http://127.0.0.1:3000/notes/<id>/retry-details      # re-summarize existing transcript
curl -sS -X POST http://127.0.0.1:3000/notes/<id>/retry-transcript   # new job, STT from the stored file
```

After `retry-transcript`, poll again. Status is set to `processing` immediately.

---

## 6. HTTP endpoints

Two routers. Same handlers for list/get/ingest/retry. **Folder ingest uses `/notes` (localhost, unauthenticated).** The phone uses `/api/notes` (device bearer).

Mounted in `apps/desktop-client/src/main.ts`:

- `app.route("/api/notes", apiNotesRouter)` — `requireSidecarOrDevice`
- `app.route("/notes", notesUiRouter)` — public on localhost; also serves `notes.html`

### 6.1 Localhost UI + ingest (`/notes`) — use these for a folder

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/notes` | | HTML Notes UI |
| GET | `/notes/list` | | `{ notes: AudioNoteDto[] }` |
| GET | `/notes/:id` | | `{ note }` |
| GET | `/notes/jobs/:jobId` | | `{ job }` |
| POST | `/notes/from-audio` | multipart `audio` | `{ note }` after **full** STT+summarize (short only) |
| POST | `/notes/from-audio-async` | multipart `audio` | `{ job, note }` stub; work continues |
| GET | `/notes/:id/audio` | | raw audio (`Content-Type` from the Artifact) |
| POST | `/notes/:id/retry-details` | | `{ note }` |
| POST | `/notes/:id/retry-transcript` | | `{ job }` |

`/notes` does **not** mount `/uploads`. That is phone-only.

### 6.2 Authenticated API (`/api/notes`) — phone / relay

All routes: `Authorization: Bearer <device-token>`. On relay also `X-Cloud-Token: Bearer <cloud-token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/notes` | List |
| GET | `/api/notes/:id` | Detail |
| GET | `/api/notes/jobs/:jobId` | Job |
| POST | `/api/notes/from-audio` | Sync short ingest |
| POST | `/api/notes/from-audio-async` | Async ingest (one multipart body) |
| POST | `/api/notes/uploads` | JSON: start chunked session |
| GET | `/api/notes/uploads/:uploadId` | Session + `received[]` indexes |
| PUT | `/api/notes/uploads/:uploadId/chunks/:index` | `{ data: "<base64>" }` 256 KB |
| POST | `/api/notes/uploads/:uploadId/complete` | **202** `{ upload }` while assembling; **200** `{ upload, note, job }` when done |
| GET | `/api/notes/:id/audio` | Raw bytes (broken over relay — use chunks) |
| GET | `/api/notes/:id/audio/meta` | `{ audio: { filename, mimeType, byteLength, totalChunks, chunkSize } }` |
| GET | `/api/notes/:id/audio/chunks/:index` | `{ chunk: { index, data, totalChunks, byteLength } }` |
| POST | `/api/notes/:id/retry-details` | Re-summarize |
| POST | `/api/notes/:id/retry-transcript` | Re-transcribe |

Upload session JSON (`POST /uploads`):

```json
{
  "filename": "recording.m4a",
  "mimeType": "audio/mp4",
  "byteLength": 12345678,
  "contentHash": "sha256:optional",
  "title": "optional",
  "template": "meeting",
  "attendees": ["..."],
  "durationSeconds": 3600
}
```

Chunk size: `NOTE_UPLOAD_CHUNK_BYTES = 256 * 1024`. Last chunk may be shorter; size is checked. Out-of-order and idempotent. Sessions live under `{oipRoot}/indexes/audio-uploads/{id}/`. Stale `uploading`/`failed` sessions older than 48h are pruned.

`complete` is **async** because the alfrd.net hub waits ~30s per hop. Client must poll `GET .../uploads/:id` until `status` is `completed` (has `noteId`) or `failed`.

### 6.3 `AudioNoteDto` / `NoteJob`

See `apps/desktop-client/src/lib/notes/service.ts` (`AudioNoteDto`) and `jobs.ts` (`NoteJob`).

`processingStatus`: `processing` | `completed` | `failed`  
`job.status`: `queued` | `processing` | `completed` | `failed`

---

## 7. Functions (call these; do not reimplement)

### 7.1 `@alfred/memory` — `packages/memory/src/audio-note-ingest.ts`

Re-exported from `packages/memory/src/index.ts`.

| Function | When |
|---|---|
| `storeAudioNoteFile({ filename, bytes, mimeType? })` | Artifact + AudioObject only |
| `beginAudioNote({ filename, bytes, title?, template?, attendees?, durationSeconds?, recordedAt? })` | Stub Episode `processing` + store file |
| `updateAudioNoteProgress({ episodeId, transcript, processingStatus?, durationSeconds? })` | Mid-job transcript patch |
| `completeAudioNote({ episodeId, transcript, metadata, title?, processingStatus?, writeObservations? })` | Finish Episode + Observations |
| `ingestAudioNote({ filename, bytes, transcript, metadata, ... })` | `begin` + `complete` when transcript **already exists** |
| `audioMimeFromFilename(filename, fallback?)` | MIME from extension |
| `emptyAudioNoteMetadata(template?)` | Empty canonical object |
| `chunkTranscript(text)` | ~2200-char Observation slices |
| `isAudioNoteEpisode(rev)` | `provenance.sourceType === "audio_note"` or Event+transcript+status |
| `audioNoteFromEpisode(rev)` | DTO-shaped read |

Tests: `packages/memory/src/audio-note-ingest.test.ts`.

### 7.2 Desktop notes service — `apps/desktop-client/src/lib/notes/service.ts`

| Function | When |
|---|---|
| `queueNoteFromAudio({ bytes, filename, ... })` | **Folder ingest / long.** `beginAudioNote` + job + `processNoteJob`. |
| `createNoteFromAudio({ bytes, filename, ... })` | Short/sync only. STT then `ingestAudioNote`. |
| `listAudioNotes` / `getAudioNote` | Read |
| `locateAudioNoteFile` / `readAudioNoteBytes` | Bytes from Artifact hash |
| `getNoteAudioMeta` / `getNoteAudioChunk` | Relay-safe playback |
| `retryNoteDetails` / `retryNoteTranscript` | User/agent retry |
| `resumeInterruptedNoteJobs` | Boot |

`processNoteJob` (private): always `transcribeAudioNote({ forceChunk: true })` then `summarizeFromTranscript` then `completeAudioNote`.

### 7.3 STT / chunk / summarize / upload / jobs

| File | Exports |
|---|---|
| `lib/notes/stt.ts` | `transcribeAudioBuffer`, `transcribeAudioNote` |
| `lib/notes/audio-chunks.ts` | `AUDIO_STT_CHUNK_SECONDS` (300), `shouldChunkAudio`, `splitAudioForStt`, `probeAudioDurationSeconds`, `resolveFfmpeg`, `joinChunkTranscripts` |
| `lib/notes/summarization.ts` | `summarizeAudioNote`, `splitTranscriptForSummary` (24k chars, map-reduce) |
| `lib/notes/uploads.ts` | `createNoteUpload`, `putNoteChunk`, `completeNoteUpload`, `requestCompleteNoteUpload`, `getNoteUpload`, `pruneStaleNoteUploads`, `resumeAssemblingNoteUploads`, `NOTE_UPLOAD_CHUNK_BYTES` |
| `lib/notes/jobs.ts` | `createNoteJob`, `getNoteJob`, `listNoteJobs`, `latestJobForNote`, `updateNoteJob`, `loadNoteJobs` |
| `lib/notes/handlers.ts` | Hono handlers used by both routers |

STT order: local `VOICE_STT_URL/transcribe_file` → OpenAI `gpt-4o-transcribe` → `whisper-1`. Failed ffmpeg chunks are skipped; a partial transcript is kept. If every chunk fails, the job fails.

### 7.4 iOS (phone only — not for folder ingest)

| Module | Role |
|---|---|
| `apps/iOS-client/src/lib/note-upload.ts` | Zustand `useNoteUpload`: `begin`, `resume`, `hydrate`, `clear`. Always chunks on relay; LAN chunks if `> 8 MB`. |
| `watchConnectionForNoteUpload()` | Resume when path returns. Wired from `app/_layout.tsx`. |
| `apps/iOS-client/src/lib/note-audio.ts` | `playableNoteAudio(id)` — LAN URL or relay chunk cache |
| `desktop-api.ts` | `listAudioNotes`, `getAudioNote`, `createAudioNoteFromFile`, upload session helpers, `waitForAudioNoteJob` (defined; list/detail polling is what the UI uses) |
| `app/notes/record.tsx` | Short/Long (default Long), templates, expo-av AAC, keep-awake, background audio |
| `app/(tabs)/notes.tsx` | List + upload banner |
| `app/notes/[id].tsx` | Boxed sections + playback |

---

## 8. Hooks and boot (so you do not double-wire)

**Desktop (`apps/desktop-client/src/main.ts`)**

- `loadNoteJobs()` then `resumeInterruptedNoteJobs()`
- `pruneStaleNoteUploads()`
- `resumeAssemblingNoteUploads()`
- ffmpeg / API-key `console.warn` if missing
- `requestTimeout` / `timeout` = 3 hours

**iOS**

- `_layout.tsx`: `useNoteUpload.hydrate()` + `watchConnectionForNoteUpload()`
- Notes list: refetch while any note is `processing`; on upload `done`, navigate to `/notes/[id]`
- Detail: poll every 4s while `processingStatus === "processing"`
- Memory detail plays `audio/*` artifacts; over relay that binary GET is still unsafe — Notes tab uses chunked download

**Graph**

- `apps/desktop-client/src/lib/memory-graph.ts` — `MemoryFileKind` includes `"audio"`
- Classic + beta graph inject `<audio controls>`

No extra hook is required for folder ingest beyond “desktop is running.”

---

## 9. Relay constraints (phone, not folder ingest)

The alfrd.net hub forwards each HTTP request as one WebSocket JSON message and waits ~30s. Desktop `cloud-connect.ts` then fetches localhost with a 25s abort.

- JSON + 256 KB base64 chunks fit.
- A whole 1–2 hour m4a does **not**.
- Raw `GET .../audio` over relay corrupts binary. Playback uses `/audio/meta` + `/audio/chunks/:index`.
- `POST .../complete` must return before assemble finishes (202 + poll).

Folder ingest on localhost ignores all of this.

---

## 10. Error / retry map

| Symptom | Likely cause | What to do |
|---|---|---|
| `Port 3000 is already in use` | Second desktop | One process only. Not `pnpm install`. |
| POST `/from-audio-async` 4xx `audio file is required` | Wrong field name | Use `audio` or `file`. |
| Job `failed` OpenAI 413 / file too large | No ffmpeg | `brew install ffmpeg`; retry-transcript. |
| Job `failed` `OPENAI_API_KEY not configured` | Missing STT | Set key or `VOICE_STT_URL`. |
| `summary` empty, transcript present | No Grok/OpenAI chat key | Set key; `retry-details`. |
| Desktop restarted mid-job | `resumeInterruptedNoteJobs` re-runs full STT | Leave Mac awake; wait. |
| Duplicate notes | Posted the same file twice | One POST per file; wait for complete. |

---

## 11. File map

```
packages/memory/src/audio-note-ingest.ts
packages/memory/src/audio-note-ingest.test.ts
packages/memory/src/oip-local/schema-org.ts          # SCHEMA_ORG.AudioObject
apps/desktop-client/src/lib/notes/service.ts
apps/desktop-client/src/lib/notes/stt.ts
apps/desktop-client/src/lib/notes/audio-chunks.ts
apps/desktop-client/src/lib/notes/summarization.ts
apps/desktop-client/src/lib/notes/uploads.ts
apps/desktop-client/src/lib/notes/jobs.ts
apps/desktop-client/src/lib/notes/handlers.ts
apps/desktop-client/src/routes/api-notes.ts
apps/desktop-client/src/routes/notes-ui.ts
apps/desktop-client/src/ui/notes.html
apps/desktop-client/src/main.ts
apps/iOS-client/src/lib/note-upload.ts
apps/iOS-client/src/lib/note-audio.ts
apps/iOS-client/src/lib/desktop-api.ts               # notes + upload helpers
apps/iOS-client/src/app/notes/record.tsx
apps/iOS-client/src/app/(tabs)/notes.tsx
apps/iOS-client/src/app/notes/[id].tsx
```

---

## 12. Checklist for the ingesting agent

1. Confirm `curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/notes` is `200`.
2. List audio files in the folder; skip non-audio.
3. For **each** file, in order: `POST /notes/from-audio-async` → poll `GET /notes/:id` until `completed` or `failed`.
4. Write a small manifest (`file → episodeId → status`). Do not invent a second memory format.
5. If a job fails, retry-transcript once; if it fails again, leave it in the manifest and continue.
6. When the folder is done, open `/notes` or the graph and spot-check one playback + boxed summary.

You are done when every file is an Episode with `provenance.sourceType === "audio_note"`, a playable Artifact, and `processingStatus` of `completed` (or an explicit `failed` row in the manifest).
