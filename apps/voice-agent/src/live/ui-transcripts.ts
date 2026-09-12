/**
 * Bridge LiveKit Agents / GPT-Live transcripts onto Alfred's existing HUD topics.
 * Clients already listen for `alfred.user` (mic STT) and `alfred.caption` (assistant).
 *
 * All publishes are fire-and-forget so captions never sit on the audio path.
 */
import type { Room } from "@livekit/rtc-node";
import { isTimedString, type TimedString } from "@livekit/agents";

export type UiTranscriptPublisher = {
  publishUser(text: string, kind: "partial" | "final"): void;
  beginCaption(text?: string): void;
  revealCaption(text: string): void;
  endCaption(reason?: string): void;
  resetAssistant(): void;
  /** Tee an agent transcription stream: pass-through chunks + parallel HUD updates. */
  teeTranscription(
    text: AsyncIterable<string | TimedString>,
  ): AsyncGenerator<string | TimedString, void, unknown>;
};

function chunkText(chunk: string | TimedString): string {
  if (typeof chunk === "string") return chunk;
  if (isTimedString(chunk)) return chunk.text;
  return String(chunk);
}

export function createRoomUiTranscriptPublisher(getRoom: () => Room | undefined): UiTranscriptPublisher {
  let lastUser = "";
  let lastUserAt = 0;
  let captionStarted = false;
  let lastReveal = "";
  let lastRevealAt = 0;

  const publish = (channel: "alfred.caption" | "alfred.user", event: Record<string, unknown>) => {
    const room = getRoom();
    const participant = room?.localParticipant;
    if (!participant) return;
    try {
      const payload = new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          channel,
          ...event,
          atMs: Date.now(),
        }),
      );
      void participant
        .publishData(payload, {
          reliable: true,
          topic: channel,
        })
        .catch((err) => {
          console.warn(`[voice:live] publish ${channel} failed:`, err);
        });
    } catch (err) {
      console.warn(`[voice:live] encode ${channel} failed:`, err);
    }
  };

  return {
    publishUser(text, kind) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const now = Date.now();
      if (kind === "partial") {
        if (trimmed === lastUser) return;
        if (now - lastUserAt < 50) return;
      } else if (trimmed === lastUser && now - lastUserAt < 30) {
        return;
      }
      lastUser = trimmed;
      lastUserAt = now;
      publish("alfred.user", { type: kind, text: trimmed });
    },

    beginCaption(text = "") {
      captionStarted = true;
      lastReveal = text;
      lastRevealAt = Date.now();
      publish("alfred.caption", { type: "start", text });
    },

    revealCaption(text) {
      if (!text) return;
      if (!captionStarted) {
        captionStarted = true;
        publish("alfred.caption", { type: "start", text: "" });
      }
      const now = Date.now();
      if (text === lastReveal) return;
      if (now - lastRevealAt < 40 && text.startsWith(lastReveal) && text.length - lastReveal.length < 2) {
        return;
      }
      lastReveal = text;
      lastRevealAt = now;
      publish("alfred.caption", { type: "reveal", text });
    },

    endCaption(reason = "complete") {
      if (!captionStarted && !lastReveal) return;
      captionStarted = false;
      publish("alfred.caption", { type: "end", reason });
    },

    resetAssistant() {
      captionStarted = false;
      lastReveal = "";
      lastRevealAt = 0;
    },

    async *teeTranscription(text) {
      let acc = "";
      let started = false;
      for await (const chunk of text) {
        const piece = chunkText(chunk);
        if (piece) {
          if (!started) {
            started = true;
            captionStarted = true;
            lastReveal = "";
            publish("alfred.caption", { type: "start", text: "" });
          }
          acc += piece;
          const now = Date.now();
          if (acc !== lastReveal && now - lastRevealAt >= 40) {
            lastReveal = acc;
            lastRevealAt = now;
            publish("alfred.caption", { type: "reveal", text: acc });
          }
        }
        yield chunk;
      }
      if (started) {
        if (acc && acc !== lastReveal) {
          lastReveal = acc;
          publish("alfred.caption", { type: "reveal", text: acc });
        }
        captionStarted = false;
        publish("alfred.caption", { type: "end", reason: "complete" });
      }
    },
  };
}
