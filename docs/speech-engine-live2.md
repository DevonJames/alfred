# ElevenLabs Speech Engine (`VOICE=live2`)

Experimental voice path. Does **not** replace cascade or GPT-Live (`make alfred VOICE=live`).

ElevenLabs handles the microphone, transcription, turn-taking, interruptions, and TTS in Alfred’s cloned voice (`ELEVENLABS_VOICE_ID`). The Mac answers with the same text brain as desktop chat (persona, memory, tools) and streams text back for speech.

Audio does not go through Alfred’s LiveKit room. iOS Talk and AlfredBot stay on cascade / `VOICE=live`.

## One-time setup

ElevenLabs dials the desktop through the existing alfrd.net relay. The desktop must already be registered (`pnpm desktop` once) and the updated `alfrd-cloud` hub must be deployed. No Fly dashboard change and no ngrok.

```bash
pnpm speech-engine:create
```

That uses `wss://api.alfrd.net/speech/<desktopClientId>/ws` from `data/desktop-client/identity.json`. Put the printed id in `.env`:

```bash
ELEVENLABS_SPEECH_ENGINE_ID=seng_...
```

The URL stays stable across reconnects. Recreate the engine only if the desktop client id changes.

## Run

```bash
make alfred VOICE=live2
```

Open `http://127.0.0.1:3000/voice/` and press Start. Stop ends the ElevenLabs conversation.

`ALFRED_SPEECH_ENGINE_DEBUG=1` logs Speech Engine websocket upgrades.

## What stays the same

| Command | Audio |
| --- | --- |
| `make alfred` | Cascade: Deepgram → Terra → ElevenLabs, LiveKit room |
| `make alfred VOICE=live` | GPT-Live / Ripple, LiveKit Agents |
| `make alfred VOICE=live2` | Speech Engine + Alfred text brain, desktop Talk only |
