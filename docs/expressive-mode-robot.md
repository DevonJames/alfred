# LiveKit Expressive Mode → Alfred-robot (weekend note)

**Status:** park for this weekend — experimental voice path first (GPT-Live); wire expressive delivery into **alfred-robot** when that stack is ready.  
**Do not** put this on the main Deepgram → Terra → ElevenLabs cascade until we’ve proven the LiveKit Agents path.

## What it is

[LiveKit Expressive Mode](https://docs.livekit.io/agents/models/tts/expressive/) lets the LLM emit delivery markup (emotion, pace, non-verbals). The Agents framework:

1. Injects provider-specific markup guidance into the LLM prompt  
2. Renders tags through Inference TTS (Fish Audio / Cartesia / Inworld / xAI)  
3. Strips tags from the user-facing transcript  
4. Publishes a normalized mood on the transcription stream as `lk.expression`

That last signal is what we want for the robot: **same turn that speaks also drives face + simple body**.

## Why it matters for alfred-robot

Voice-only Alfred can sound flat or mismatched. On a physical head/body, mismatched affect is worse — a warm “sorry to hear that” with a grin reads as broken.

Expressive mode gives us a **stable mood enum** (not free-form TTS vibes) we can map to:

- **Face** — brows, eyelids, mouth shape, gaze soft/hard  
- **Head / neck** — nod, shake, tilt, slight lean-in / pull-back  
- **Light body** — shoulder ease, weight shift (keep tiny; no full gestures yet)

Goal: **appropriate** affect, not maximum theater.

## Mood → expression map (v0)

LiveKit normalizes to roughly these moods (names may drift — treat as a switch table, fall back to `calm`):

| Mood | Face (simple) | Head / body |
|------|----------------|-------------|
| `calm` | Neutral soft eyes, closed-lip rest | Level head, still |
| `happy` | Soft smile, slightly raised cheeks | Light nod optional on affirmations |
| `excited` | Wider eyes, bigger smile | Quicker small nods; slight forward lean |
| `playful` | Asymmetric smile / raised brow | Occasional head tilt |
| `surprised` | Raised brows, open lids | Quick tilt-back, then settle |
| `curious` | One brow up, focused gaze | Head tilt toward user |
| `hopeful` | Soft smile, open brows | Slow nod |
| `empathetic` | Softened lids, concern mouth | Slow nod; slight tilt |
| `sad` | Downturned mouth, heavier lids | Chin slightly down; minimal motion |
| `anxious` | Tighter mouth, darting micro-gaze | Small unsettled shifts; avoid big gestures |
| `angry` | Drawn brows, firm mouth | Still / squared; **no** aggressive motion |

Keep amplitudes low on hardware until tuned — robot “angry” should read composed, not cartoon rage.

## Signal path (when we integrate)

```
AgentSession (expressive=true)
  → TTS audio (as today)
  → lk.transcription + attributes['lk.expression']  // { mood, expression }
  → robot expression controller
       → face blendshapes / LED face
       → head servos (nod / shake / tilt)
```

Non-React clients (our desktop voice UI / robot bridge) should read `lk.expression` off the text stream headers — same idea as LiveKit’s `useAgentExpression` hook, without React.

Clear mood ~2 agent turns after the last expression (framework behavior) so the face doesn’t stick on `excited` forever.

## Out of scope for first robot pass

- Full arm/hand choreography  
- Lip-sync beyond whatever the face already does from audio  
- Driving expression from our **current** ElevenLabs cascade (no `lk.expression` there)  
- Replacing GPT-Live or cascade experiments — this is a **consumer of** the Agents expressive path

## Weekend checklist

1. Confirm which Inference TTS we standardize on for robot demos (Fish Audio vs Cartesia).  
2. Spike: log `lk.expression` mood from an expressive Agents session into the robot bridge.  
3. Implement the v0 face + head table above with clamped servo ranges.  
4. Test good-news / bad-news turns; verify mood clears and never fights barge-in motion.  
5. Only then consider exposing expressive + robot affect as a single experimental Talk mode.

## Refs

- Docs: https://docs.livekit.io/agents/models/tts/expressive/  
- Blog: https://livekit.com/blog/making-voice-agents-sound-human-with-expressive-mode  
- Related experimental track: GPT-Live full-duplex (`docs.livekit.io/agents/models/realtime/plugins/gpt-live/`) — separate opt-in; expressive mode pairs with pipeline Agents, not GPT-Live’s native audio path.
