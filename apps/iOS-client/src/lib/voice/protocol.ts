/**
 * LiveKit data-channel protocol (voice guide §8).
 *
 * The Mac's voice agent publishes two reliable topics: `alfred.caption` for
 * what Alfred is saying and `alfred.user` for live STT of what you said. Both
 * arrive as UTF-8 JSON on a WebRTC data channel, which means the bytes are
 * untrusted in the ordinary way — a malformed frame must never take down the
 * call, so every parse returns null rather than throwing.
 *
 * These are pure functions on purpose: they are the half of voice that can be
 * exercised without a LiveKit room.
 */

export const CAPTION_TOPIC = "alfred.caption";
export const USER_TOPIC = "alfred.user";

/** The Mac's voice agent joins under this identity unless LIVEKIT_IDENTITY says otherwise. */
export const AGENT_IDENTITY = "alfred-agent";

export interface CaptionMessage {
  channel: typeof CAPTION_TOPIC;
  /** start = new utterance, reveal = more of it is spoken, end = finished. */
  type: "start" | "reveal" | "end";
  text: string;
  reason: string | null;
  atMs: number | null;
}

export interface UserTranscriptMessage {
  channel: typeof USER_TOPIC;
  type: "partial" | "final";
  text: string;
  atMs: number | null;
}

export type VoiceMessage = CaptionMessage | UserTranscriptMessage;

function asRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asMillis(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Decode one data frame.
 *
 * `topic` is what the transport labelled the frame. The reference browser
 * client tries both parsers when the topic is missing, because some LiveKit
 * versions don't deliver it — so an absent topic means "trust the payload's own
 * `channel`", while a present topic must agree with it.
 */
export function parseVoiceMessage(raw: string, topic?: string | null): VoiceMessage | null {
  const body = asRecord(raw);
  if (!body) return null;

  const channel = typeof body.channel === "string" ? body.channel : topic ?? null;
  if (!channel) return null;
  // A frame claiming to be a caption while riding the user topic is a bug
  // somewhere upstream; dropping it is safer than showing Alfred's words as
  // the user's own.
  if (topic && channel !== topic) return null;

  const text = typeof body.text === "string" ? body.text : "";
  const type = typeof body.type === "string" ? body.type : "";
  const atMs = asMillis(body.atMs);

  if (channel === CAPTION_TOPIC) {
    if (type !== "start" && type !== "reveal" && type !== "end") return null;
    return {
      channel: CAPTION_TOPIC,
      type,
      text,
      reason: typeof body.reason === "string" ? body.reason : null,
      atMs,
    };
  }

  if (channel === USER_TOPIC) {
    if (type !== "partial" && type !== "final") return null;
    return { channel: USER_TOPIC, type, text, atMs };
  }

  return null;
}

/** Convenience for transports that hand over raw bytes. */
export function decodeVoiceFrame(payload: Uint8Array, topic?: string | null): VoiceMessage | null {
  let raw: string;
  try {
    raw = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  return parseVoiceMessage(raw, topic);
}

/**
 * The caption HUD state (§8). `reveal` carries the prefix spoken so far, and
 * the guide requires that prefix to be monotonic — a late or reordered frame
 * must not make the caption jump backwards mid-sentence.
 */
export interface CaptionState {
  /** Full text of the current utterance, as announced by `start`. */
  text: string;
  /** How much of it has been spoken. */
  revealed: number;
  speaking: boolean;
}

export const IDLE_CAPTION: CaptionState = { text: "", revealed: 0, speaking: false };

export function applyCaption(state: CaptionState, message: CaptionMessage): CaptionState {
  switch (message.type) {
    case "start":
      return { text: message.text, revealed: 0, speaking: true };
    case "reveal":
      return {
        // `reveal` may also extend the utterance, so take the longer text.
        text: message.text.length > state.text.length ? message.text : state.text,
        revealed: Math.max(state.revealed, message.text.length),
        speaking: true,
      };
    case "end":
      return {
        text: message.text || state.text,
        revealed: (message.text || state.text).length,
        speaking: false,
      };
  }
}

/** The visible caption line: everything spoken so far, never more than exists. */
export function revealedText(state: CaptionState): string {
  return state.text.slice(0, Math.min(state.revealed, state.text.length));
}
