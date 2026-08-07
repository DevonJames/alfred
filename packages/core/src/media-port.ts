import type { AudioFrame, VadSignal } from "@alfred/contracts";

/** Live caption events for remote UI (LiveKit data channel, etc.). */
export type AssistantCaptionEvent =
  | { type: "start"; text: string }
  | { type: "reveal"; text: string }
  | { type: "end"; reason?: string };

/** User mic STT for remote UI. */
export type UserTranscriptEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string };

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
}
