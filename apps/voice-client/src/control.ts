import type { Room } from "livekit-client";

export type UiLayout = "voice" | "chat";

export type UiCommand =
  | { type: "layout"; layout: UiLayout }
  | { type: "dictate"; active: boolean }
  | { type: "text"; text: string }
  | { type: "stop" }
  | { type: "mute"; muted: boolean };

const CHANNEL = "alfred.control";

/** Publish a UI command to the voice agent over LiveKit. */
export async function publishControl(room: Room | undefined, command: UiCommand): Promise<void> {
  if (!room) return;
  const payload = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      channel: CHANNEL,
      ...command,
      atMs: Date.now(),
    }),
  );
  await room.localParticipant.publishData(payload, {
    reliable: true,
    topic: CHANNEL,
  });
  // GPT-Live's worker also listens on LiveKit's text stream (`lk.chat`).
  if (command.type === "text") {
    try {
      await room.localParticipant.sendText(command.text, { topic: "lk.chat" });
    } catch (err) {
      console.warn("[voice-client] lk.chat sendText failed", err);
    }
  }
}
