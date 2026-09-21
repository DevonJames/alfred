import { describe, expect, it, vi } from "vitest";
import { applyLiveUiCommand, handleLiveControlPayload } from "./control.js";

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe("handleLiveControlPayload", () => {
  it("routes typed text and ignores empty / non-control packets", () => {
    const onText = vi.fn();
    const onStop = vi.fn();
    const onMute = vi.fn();
    const handlers = { onText, onStop, onMute };

    expect(
      handleLiveControlPayload(
        encode({ v: 1, channel: "alfred.control", type: "text", text: "  hello  " }),
        "alfred.control",
        handlers,
      ),
    ).toBe(true);
    expect(onText).toHaveBeenCalledWith("hello");

    expect(
      handleLiveControlPayload(
        encode({ v: 1, channel: "alfred.control", type: "text", text: "   " }),
        "alfred.control",
        handlers,
      ),
    ).toBe(false);

    expect(
      handleLiveControlPayload(
        encode({ v: 1, channel: "alfred.caption", type: "start", text: "nope" }),
        "alfred.caption",
        handlers,
      ),
    ).toBe(false);
    expect(onText).toHaveBeenCalledTimes(1);
  });

  it("routes stop and mute", () => {
    const onText = vi.fn();
    const onStop = vi.fn();
    const onMute = vi.fn();

    expect(applyLiveUiCommand({ type: "stop" }, { onText, onStop, onMute })).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);

    expect(applyLiveUiCommand({ type: "mute", muted: true }, { onText, onStop, onMute })).toBe(
      true,
    );
    expect(onMute).toHaveBeenCalledWith(true);
  });

  it("ignores layout and dictate (mic/layout stay on the client)", () => {
    const onText = vi.fn();
    expect(applyLiveUiCommand({ type: "layout", layout: "chat" }, { onText })).toBe(false);
    expect(applyLiveUiCommand({ type: "dictate", active: true }, { onText })).toBe(false);
    expect(onText).not.toHaveBeenCalled();
  });
});
