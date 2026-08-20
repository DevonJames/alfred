import type { AudioFrame, VadSignal } from "@alfred/contracts";
import type {
  AssistantCaptionEvent,
  MediaPort,
  UiCommand,
  UserTranscriptEvent,
} from "@alfred/core";

/**
 * LiveKit is transport only. Conversation policy stays in @alfred/core.
 *
 * This bridge can be driven by:
 * - A LiveKit Agents worker forwarding PCM/VAD into the handlers
 * - Unit tests pushing synthetic frames
 *
 * It does NOT import LiveKit agent policy or host an FSM.
 */
export class LiveKitMediaBridge implements MediaPort {
  private audioHandlers = new Set<(frame: AudioFrame) => void>();
  private vadHandlers = new Set<(signal: VadSignal) => void>();
  private playbackHandlers = new Set<(frame: AudioFrame) => void | Promise<void>>();
  private stopHandlers = new Set<(reason?: string) => void>();
  private captionHandlers = new Set<(event: AssistantCaptionEvent) => void | Promise<void>>();
  private userTranscriptHandlers = new Set<(event: UserTranscriptEvent) => void | Promise<void>>();
  private uiCommandHandlers = new Set<(command: UiCommand) => void>();
  private stopped = false;

  onAudioFrame(handler: (frame: AudioFrame) => void): () => void {
    this.audioHandlers.add(handler);
    return () => this.audioHandlers.delete(handler);
  }

  onVad(handler: (signal: VadSignal) => void): () => void {
    this.vadHandlers.add(handler);
    return () => this.vadHandlers.delete(handler);
  }

  /** Agents worker subscribes to assistant PCM for room publish. */
  onPlayback(handler: (frame: AudioFrame) => void | Promise<void>): () => void {
    this.playbackHandlers.add(handler);
    return () => this.playbackHandlers.delete(handler);
  }

  /** Room session publishes captions on the LiveKit data channel. */
  onCaption(handler: (event: AssistantCaptionEvent) => void | Promise<void>): () => void {
    this.captionHandlers.add(handler);
    return () => this.captionHandlers.delete(handler);
  }

  /** Room session publishes user STT on the LiveKit data channel. */
  onUserTranscript(handler: (event: UserTranscriptEvent) => void | Promise<void>): () => void {
    this.userTranscriptHandlers.add(handler);
    return () => this.userTranscriptHandlers.delete(handler);
  }

  /** Called by LiveKit track subscriber with decoded PCM. */
  pushInboundAudio(frame: AudioFrame): void {
    for (const h of this.audioHandlers) h(frame);
  }

  /** Called by local/Silero VAD — immediate barge-in evidence only. */
  pushVad(signal: VadSignal): void {
    for (const h of this.vadHandlers) h(signal);
  }

  async playPcm(frame: AudioFrame): Promise<void> {
    if (this.stopped) return;
    // Await publishers so voice session stays "speaking" until frames are queued.
    for (const h of this.playbackHandlers) {
      if (this.stopped) return;
      await h(frame);
      if (this.stopped) return;
    }
  }

  /** Room publisher listens here to clear AudioSource queues on barge-in. */
  onStopPlayback(handler: (reason?: string) => void): () => void {
    this.stopHandlers.add(handler);
    return () => this.stopHandlers.delete(handler);
  }

  async stopPlayback(reason?: string): Promise<void> {
    this.stopped = true;
    for (const h of this.stopHandlers) h(reason);
  }

  resumePlayback(): void {
    this.stopped = false;
  }

  async publishCaption(event: AssistantCaptionEvent): Promise<void> {
    for (const h of this.captionHandlers) {
      await h(event);
    }
  }

  async publishUserTranscript(event: UserTranscriptEvent): Promise<void> {
    for (const h of this.userTranscriptHandlers) {
      await h(event);
    }
  }

  onUiCommand(handler: (command: UiCommand) => void): () => void {
    this.uiCommandHandlers.add(handler);
    return () => this.uiCommandHandlers.delete(handler);
  }

  /** Called by LiveKitRoomSession when the client publishes `alfred.control`. */
  pushUiCommand(command: UiCommand): void {
    for (const h of this.uiCommandHandlers) h(command);
  }

  reset(): void {
    this.stopped = false;
  }
}
