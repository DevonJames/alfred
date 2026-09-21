import { parseUiCommand, type UiCommand } from "@alfred/core";

/** Callbacks for inbound `alfred.control` packets on the GPT-Live worker. */
export type LiveControlHandlers = {
  onText: (text: string) => void;
  onStop?: () => void;
  onMute?: (muted: boolean) => void;
};

/** Dispatch a parsed UI command. Layout/dictate are client-side on this stack. */
export function applyLiveUiCommand(command: UiCommand, handlers: LiveControlHandlers): boolean {
  if (command.type === "text") {
    const text = command.text.trim();
    if (!text) return false;
    handlers.onText(text);
    return true;
  }
  if (command.type === "stop") {
    handlers.onStop?.();
    return true;
  }
  if (command.type === "mute") {
    handlers.onMute?.(command.muted);
    return true;
  }
  return false;
}

/** Parse a LiveKit data payload and dispatch if it is an `alfred.control` command. */
export function handleLiveControlPayload(
  payload: Uint8Array,
  topic: string | undefined | null,
  handlers: LiveControlHandlers,
): boolean {
  const command = parseUiCommand(payload, topic);
  if (!command) return false;
  return applyLiveUiCommand(command, handlers);
}
