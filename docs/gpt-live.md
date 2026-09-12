# GPT-Live experimental voice stack

**Status:** experimental opt-in. Does **not** replace the cascade (`pnpm voice`).  
**Voice:** OpenAI Ripple for now (distinct from ElevenLabs Alfred); custom clone later via OpenAI sales.

## Run

```bash
# desktop + GPT-Live worker (sets ALFRED_VOICE_STACK=live for token dispatch)
make alfred VOICE=live
# or:
make alfred-live

# voice worker only
pnpm voice:live
```

Cascade remains:

```bash
make alfred          # or pnpm voice
```

Do **not** run both workers at once.

## What it is

LiveKit Agents worker (`apps/voice-agent/src/main-live.ts`) using OpenAI **GPT-Live-1** via `@livekit/agents-plugin-openai` (`GPTLiveModel`). Full-duplex audio; backend Responses model (`gpt-5.6-luna` by default) runs tools/reasoning.

Same Alfred brain as cascade: persona files, memory retrieve/store, due reminders, daily briefing, weather, Elgato lights, `delegate_task` harnesses.

## Session lifecycle (important)

Cascade keeps one long-lived room (`LIVEKIT_ROOM`, default `alfred-dev`) with `alfred-agent` always joined.

GPT-Live is different:

1. Each Talk mint creates a **fresh room** (`{LIVEKIT_ROOM}-live-{suffix}`).
2. The client JWT includes `RoomAgentDispatch` for `alfred-live`, and desktop also calls the Agent Dispatch API.
3. The worker accepts the job, joins as `alfred-agent`, runs GPT-Live.
4. When the client leaves, LiveKit ends the job (no standard participants left). Shutdown hooks close the AgentSession + GPT-Live model so OpenAI sockets do not linger.

Live transcripts (user + assistant) publish on the same data topics as cascade (`alfred.user`, `alfred.caption`) via fire-and-forget `publishData` — they do not sit on the audio path. GPT-Live `transcript_delta` / `UserInputTranscribed` feed the HUD in parallel with speech.

**Clients:** desktop `voice-client` and the iOS Talk tab both consume those topics. iOS does not pick a stack itself — it joins whatever room `/api/session/token` mints when the Mac is running cascade or `VOICE=live`, and renders captions the same way either way.

That unique-room design matters because LiveKit **only applies token agent dispatch when the room is first created**. Reusing a fixed room would leave Talk connected with **no agent** after the first session.

`/api/session/status` reports `agentPresent: true` whenever LiveKit is configured and `ALFRED_VOICE_STACK=live` (there is no always-on participant to probe). Ensure `pnpm voice:live` is running before Talk.

## Env

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Needs GPT-Live alpha access |
| `LIVEKIT_URL` / `API_KEY` / `API_SECRET` | — | Same as cascade |
| `ALFRED_VOICE_STACK` | unset (= cascade) | Set `live` for client token dispatch |
| `LIVEKIT_AGENT_NAME` | `alfred-live` | Explicit Agents dispatch name |
| `ALFRED_GPT_LIVE_VOICE` | `ripple` | GPT-Live voice (custom Alfred clone later via OpenAI sales) |
| `ALFRED_GPT_LIVE_BACKEND_MODEL` | `gpt-5.6-luna` | Responses backend |

Memory / persona / briefing env vars are shared with cascade.

## Refs

- https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/
- https://docs.livekit.io/agents/server/agent-dispatch/
- Weekend robot affect: [expressive-mode-robot.md](./expressive-mode-robot.md)
