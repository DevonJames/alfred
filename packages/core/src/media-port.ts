import type { AudioFrame, VadSignal } from "@alfred/contracts";

/** Live caption events for remote UI (LiveKit data channel, etc.). */
export type AssistantCaptionEvent =
  | { type: "start"; text: string }
  | { type: "reveal"; text: string }
  | { type: "end"; reason?: string };

/** User mic STT for remote UI. */
export type UserTranscriptEvent =
  { type: "partial"; text: string } | { type: "final"; text: string };

export type UiLayout = "voice" | "chat";

/** Inbound UI commands from a voice client (LiveKit data topic `alfred.control`). */
export type UiCommand =
  | { type: "layout"; layout: UiLayout }
  | { type: "dictate"; active: boolean }
  | { type: "text"; text: string };

/**
 * Media transport boundary. LiveKit implements this; core never imports LiveKit.
 */
export interface MediaPort {
  /** Subscribe to inbound mic PCM frames. */
  onAudioFrame(handler: (frame: AudioFrame) => void): () => void;
  /** Subscribe to local/client VAD for immediate barge-in (not turn policy). */
  onVad(handler: (signal: VadSignal) => void): () => void;
  /** Publish assistant PCM to the room. */
  playPcm(frame: AudioFrame): Promise<void>;
  /** Immediately stop / duck assistant playback (stays stopped until resumePlayback). */
  stopPlayback(reason?: string): Promise<void>;
  /** Allow playPcm again after a barge-in stop. */
  resumePlayback(): void | Promise<void>;
  /** Broadcast what the assistant is saying (optional transport feature). */
  publishCaption(event: AssistantCaptionEvent): Promise<void>;
  /** Broadcast what the user said (STT), for the client HUD. */
  publishUserTranscript(event: UserTranscriptEvent): Promise<void>;
  /** Subscribe to inbound UI commands (layout / dictate / typed text). */
  onUiCommand(handler: (command: UiCommand) => void): () => void;
}

/** No-op media port for text-only sessions and unit tests. */
export class NullMediaPort implements MediaPort {
  onAudioFrame(): () => void {
    return () => {};
  }
  onVad(): () => void {
    return () => {};
  }
  async playPcm(): Promise<void> {}
  async stopPlayback(): Promise<void> {}
  resumePlayback(): void {}
  async publishCaption(): Promise<void> {}
  async publishUserTranscript(): Promise<void> {}
  onUiCommand(): () => void {
    return () => {};
  }
}

const CONTROL_CHANNEL = "alfred.control";

/** Parse an `alfred.control` data payload. Returns undefined if the packet is not a command. */
export function parseUiCommand(data: Uint8Array, topic?: string | null): UiCommand | undefined {
  if (topic && topic !== CONTROL_CHANNEL) return undefined;
  try {
    const raw = JSON.parse(new TextDecoder().decode(data)) as {
      channel?: string;
      type?: string;
      layout?: string;
      active?: boolean;
      text?: string;
    };
    if (raw.channel && raw.channel !== CONTROL_CHANNEL) return undefined;
    if (raw.type === "layout" && (raw.layout === "voice" || raw.layout === "chat")) {
      return { type: "layout", layout: raw.layout };
    }
    if (raw.type === "dictate" && typeof raw.active === "boolean") {
      return { type: "dictate", active: raw.active };
    }
    if (raw.type === "text" && typeof raw.text === "string") {
      return { type: "text", text: raw.text };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
