# iOS LiveKit Voice — Implementation Guide

**Audience:** iOS coding agent  
**Purpose:** Implement speaking Talk mode by joining the same LiveKit room the Mac voice stack uses.  
**Do not** implement HTTP mic upload (`/api/conversation/audio-turn`). That path does not exist and is not the product architecture.

Reference client (browser): [`apps/voice-client/src/main.ts`](../apps/voice-client/src/main.ts)  
Desktop token API: `POST /api/session/token` (device bearer required)  
Mac agent process: `pnpm voice` (must be running)

---

# 1. Architecture (read this first)

```text
iOS app                          Mac
──────                          ───
1. desktopFetch POST /api/session/token
   Authorization: Bearer <device_token>
   (+ X-Cloud-Token if relay)
        │
        ▼
   { url, room, identity, token }   ◄── minted by pnpm desktop
        │
        ▼
2. LiveKit SDK: Room.connect(url, token)
3. Enable microphone (user gesture)
4. Subscribe to remote audio tracks
        │  WebRTC via LiveKit Cloud/SFU
        ▼
                              pnpm voice (identity: alfred-agent)
                              ├── subscribe iOS mic PCM
                              ├── Deepgram STT → OpenAI LLM → ElevenLabs TTS
                              ├── publish assistant audio track
                              └── publishData topics:
                                    alfred.caption  (assistant text)
                                    alfred.user     (user STT)
```

| Component | Owns |
|-----------|------|
| iOS | Mic capture, speaker playback, LiveKit join, captions UI, audio session / permissions |
| `pnpm desktop` | Token mint, pairing, memory HTTP, text `/api/conversation/turn` |
| `pnpm voice` | Conversation Core policy, STT/LLM/TTS, assistant audio publish |
| LiveKit | WebRTC transport only — **not** the conversation state machine |

If `pnpm voice` is not running, the phone can join the room and publish mic, but nobody will answer.

---

# 2. Prerequisites on the phone (already should exist)

1. Cloud claim + discovery → `alfred_server_url`
2. Device PIN pair → `alfred_device_token`
3. `desktopFetch` that attaches:
   - `Authorization: Bearer <alfred_device_token>` on every desktop API call
   - `X-Cloud-Token: Bearer <alfred_cloud_token>` **only** when base URL contains `/proxy/`

Voice does **not** replace pairing. Token mint requires a paired device.

---

# 3. Package / SDK

Use LiveKit’s official React Native / Expo path:

| Stack | Package |
|-------|---------|
| Expo (Dev Client required — not Expo Go) | `@livekit/react-native` + `@livekit/react-native-expo-plugin` (follow current LiveKit Expo docs) |
| Bare RN | `@livekit/react-native` + native LiveKit pods |

Also typically needed:

- Mic permission strings in `app.json` / Info.plist  
- Possibly `@config-plugins/react-native-webrtc` / LiveKit config plugin depending on Expo SDK version  

**Confirm current install steps from LiveKit docs for your Expo SDK** — the protocol below is stable; package names/plugins change.

Register URL scheme / plugins as required by LiveKit RN. Rebuild the native binary after adding the SDK (EAS / `npx expo prebuild` + run).

---

# 4. Permissions & audio session (mandatory)

## Info.plist / Expo

```text
NSMicrophoneUsageDescription =
  "Alfred uses the microphone so you can talk to your assistant on your Mac."
```

Optional but recommended when using continuous listen:

```text
UIBackgroundModes = audio   # only if you keep short background sessions
```

Do **not** request `NSSpeechRecognitionUsageDescription` for this path — STT is cloud/desktop via LiveKit PCM, not Apple Speech.

## AVAudioSession (before `Room.connect`)

Configure equivalently to:

```text
category: .playAndRecord
mode: .voiceChat          // enables hardware AEC path
options: [.allowBluetooth, .defaultToSpeaker]  // speakerphone = explicit user toggle
```

Handle:

- Phone call / Siri interruptions → pause: mute mic or disconnect; resume on end  
- Route changes (Bluetooth / wired) → keep room connected; LiveKit renegotiates  
- Silent switch: product may still play assistant audio; provide in-app mute  

Request mic permission **on first voice session start** (user gesture), not at app launch.

---

# 5. Mint a join token

```http
POST {alfred_server_url}/api/session/token
Authorization: Bearer <alfred_device_token>
Content-Type: application/json
X-Cloud-Token: Bearer <cloud_jwt>   # relay only
```

`GET` with the same auth also works.

### Success `200`

```json
{
  "url": "wss://….livekit.cloud",
  "room": "alfred-dev",
  "identity": "alfred-ios-a1b2c3",
  "token": "<jwt>"
}
```

| Field | Use |
|-------|-----|
| `url` | LiveKit server URL for `Room.connect` |
| `token` | Participant JWT (TTL typically 1 hour) |
| `room` | Display / diagnostics only (grant already embeds room) |
| `identity` | This phone’s participant id (prefix `alfred-ios-`) |

### Errors

| Status | Meaning |
|--------|---------|
| `401` | Missing/invalid device bearer — re-pair |
| `500` | Mac `.env` missing `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` |

Optional preflight:

```http
GET /api/session/status
Authorization: Bearer <device_token>
```

```json
{
  "ok": true,
  "livekitConfigured": true,
  "room": "alfred-dev",
  "agentHint": "Run `pnpm voice` on the Mac so alfred-agent joins the LiveKit room."
}
```

If `livekitConfigured: false`, show “Mac LiveKit not configured” and keep text Talk.

---

# 6. Join flow (canonical — mirror voice-client)

Implement this sequence exactly:

```text
1. User taps Talk / Hold-to-talk / Start session (gesture)
2. Ensure AVAudioSession configured
3. POST /api/session/token → { url, token, identity, room }
4. Create Room with:
     - echoCancellation: true
     - noiseSuppression: true
     - autoGainControl: true
     - mono mic if SDK allows
5. Register handlers BEFORE connect:
     - TrackSubscribed → if audio, attach/play
     - TrackUnsubscribed → detach
     - DataReceived → parse alfred.caption / alfred.user
     - Disconnected → teardown UI
6. await room.connect(url, token)
7. await enable microphone (localParticipant.setMicrophoneEnabled(true)
   or equivalent RN API)
8. Attach any already-published remote audio tracks
   (agent may have joined before the phone)
9. UI: Online / mic armed
```

### End session

```text
1. Disable microphone
2. room.disconnect()
3. POST /api/session/end  (best-effort; desktop ack only)
4. Clear captions / waveform / “linked” state
```

### Reconnect

On network blip or app foreground:

1. If room disconnected, mint a **fresh** token (don’t reuse expired JWT)
2. Reconnect with backoff
3. Re-enable mic only if session still intended active

---

# 7. What to publish / subscribe

## Publish

- **One microphone track** from the local participant  
- Keep it publishing while the assistant is speaking (required for barge-in)  
- Do **not** publish camera/screen for v1  

## Subscribe

- **All remote audio tracks** (or specifically participant identity `alfred-agent` if you filter)  
- Agent default identity: `LIVEKIT_IDENTITY` or **`alfred-agent`**  
- Play with `playsInline`-equivalent; start playback after the connect gesture to satisfy iOS autoplay rules  

## Do not

- Run on-device STT and POST transcripts as the primary voice path  
- Call `/api/conversation/turn` for every spoken utterance while LiveKit voice is active (that’s the **text** shim; voice turns are handled inside `pnpm voice`)  
- Implement local interruption arbitration  

---

# 8. Data channels — captions & user transcript

Agent publishes reliable data messages:

| Topic | Purpose |
|-------|---------|
| `alfred.caption` | Assistant speech captions (HUD) |
| `alfred.user` | Live user STT from desktop Deepgram |

Payload is UTF-8 JSON:

```json
{
  "v": 1,
  "channel": "alfred.caption",
  "type": "start" | "reveal" | "end",
  "text": "…",
  "reason": "optional on end",
  "atMs": 1730000000000
}
```

```json
{
  "v": 1,
  "channel": "alfred.user",
  "type": "partial" | "final",
  "text": "…",
  "atMs": 1730000000000
}
```

### Assistant caption types

| `type` | Client behavior |
|--------|-----------------|
| `start` | New utterance; set full text; begin reveal |
| `reveal` | Update revealed prefix (monotonic length) |
| `end` | Finish reveal; mark standby |

### User transcript types

| `type` | Client behavior |
|--------|-----------------|
| `partial` | Show interim STT |
| `final` | Lock line as committed user turn |

Ignore payloads whose `channel` doesn’t match the topic you’re handling. Treat missing topic as try-both (browser client does this for robustness).

---

# 9. UX modes

## Continuous (matches desktop voice-client)

- Mic stays enabled for the whole LiveKit session  
- Show system + in-app recording indicators  
- Best for Conversation Core turn detection / barge-in  

## Hold-to-talk (recommended default on cellular / first launch)

- Connect room on session start (or on first hold)  
- Enable mic only while control is held / toggled on  
- Disable mic on release (stay in room so assistant audio can still play)  
- Note: very short holds may truncate STT; prefer ≥ ~400ms or use toggle-to-talk  

## Text fallback

Keep `/api/conversation/turn` for typing. It is a **separate** desktop text orchestrator from the LiveKit voice session — not a substitute for mic audio. After voice ships, product may later unify history; for now do not assume text turns appear in LiveKit captions or vice versa.

---

# 10. Suggested module layout

```text
src/lib/voice/
  livekit-session.ts     # connect/disconnect, mic enable, track attach
  session-token.ts       # POST /api/session/token via desktopFetch
  captions.ts            # parse alfred.caption
  user-transcript.ts     # parse alfred.user
  audio-session.ts       # AVAudioSession configure / interruption handlers

src/screens/TalkScreen.tsx
  - transport: 'text' | 'livekit'
  - if livekitConfigured / token ok → offer Speak
  - else → typing only + explanation
```

Detect transport from a successful token response (presence of `url` + `token`), not from guessing. You can also gate Speak behind `GET /api/session/status` → `livekitConfigured`.

---

# 11. Pseudocode (Expo / RN style)

```ts
import { Room, RoomEvent, Track } from 'livekit-client';
// + @livekit/react-native registerGlobals() once at app start

async function startVoiceSession(desktopFetch: typeof fetch) {
  await configurePlayAndRecordVoiceChat();

  const res = await desktopFetch('/api/session/token', { method: 'POST' });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const { url, token, identity, room: roomName } = await res.json();

  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  room
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        // attach to Audio / play; show participant.identity (expect alfred-agent)
      }
    })
    .on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
      const text = new TextDecoder().decode(payload);
      const msg = JSON.parse(text);
      if (!topic || topic === 'alfred.caption') handleCaption(msg);
      if (!topic || topic === 'alfred.user') handleUserTranscript(msg);
    })
    .on(RoomEvent.Disconnected, () => teardown());

  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);

  // Attach tracks already published before we joined
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      if (pub.track && pub.kind === Track.Kind.Audio) {
        // attach
      }
    }
  }

  return { room, identity, roomName };
}
```

Exact RN API names may differ slightly (`AudioSession`, `registerGlobals`); follow LiveKit RN docs for your SDK version while keeping this control flow.

---

# 12. Mac-side checklist (tell the user)

Before testing Speak on device:

1. `pnpm desktop` running and phone paired  
2. `pnpm voice` running (same LiveKit room / `.env` as desktop)  
3. `.env` has `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, optional `LIVEKIT_ROOM` (default `alfred-dev`)  
4. Phone and Mac don’t need LAN for media — WebRTC goes to LiveKit Cloud; only control APIs use alfrd.net discovery/relay  

---

# 13. Acceptance criteria

- [ ] After pair, Talk can mint token with device bearer (401 without it)  
- [ ] Mic permission requested on first Speak gesture  
- [ ] Room connects; identity shown in debug UI  
- [ ] With `pnpm voice` up, user speech produces assistant audio on device  
- [ ] Barge-in works with mic left enabled during assistant speech (continuous mode)  
- [ ] Captions render from `alfred.caption`  
- [ ] User partial/final STT renders from `alfred.user`  
- [ ] Disconnect cleans up tracks and calls `/api/session/end`  
- [ ] No dependency on `/api/conversation/audio-turn` or `/transcript` for voice  
- [ ] Text Talk still works when mic denied or LiveKit misconfigured  

---

# 14. Explicit non-goals for this iOS pass

- HTTP upload of recorded audio buffers to desktop  
- On-device Apple Speech as primary STT  
- Hosting Conversation Core or memory on the phone  
- CallKit / always-on hotword  
- Unifying text-orchestrator history with vault voice session history (follow-up)

---

# 15. One-sentence brief for the iOS agent

**Mint a LiveKit token from `POST /api/session/token`, connect with `@livekit/react-native`, publish the mic, play `alfred-agent`’s audio track, and render data topics `alfred.caption` / `alfred.user` — while `pnpm voice` runs on the Mac; do not POST microphone audio over HTTP.**
