import { unlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clampStick, HEAD_CHANNELS, loadHeadPrefs, stickToDeltas, trackingEnabled } from "./head.js";

describe("stickToDeltas", () => {
  it("ignores the deadzone", () => {
    expect(stickToDeltas({ neck: 0.05, tilt: -0.04, roll: 0.07 }, 0.1)).toEqual({
      neck: 0,
      tilt: 0,
      roll: 0,
    });
  });

  it("maps right/up stick to the live neck polarity", () => {
    const d = stickToDeltas({ neck: 1, tilt: 1, roll: 1 }, 0.1);
    expect(d.neck).toBeCloseTo(4.2);
    expect(d.tilt).toBeCloseTo(3.2);
    expect(d.roll).toBeCloseTo(3.6);
  });

  it("maps left/down the other way", () => {
    const d = stickToDeltas({ neck: -1, tilt: -1, roll: -1 }, 0.1);
    expect(d.neck).toBeCloseTo(-4.2);
    expect(d.tilt).toBeCloseTo(-3.2);
    expect(d.roll).toBeCloseTo(-3.6);
  });
});

describe("HEAD_CHANNELS", () => {
  it("matches alfred-home alfred_cli / face_tracker", () => {
    expect(HEAD_CHANNELS).toEqual({ body: 0, neck: 1, tilt: 2, roll: 3 });
  });
});

describe("tracking default", () => {
  it("stays off until the phone turns it on", () => {
    const path = `/tmp/alfredbot-head-prefs-test-${process.pid}.json`;
    process.env.ALFREDBOT_HEAD_PREFS = path;
    try {
      unlinkSync(path);
    } catch {
      // first run
    }
    expect(loadHeadPrefs().tracking).toBe(false);
    expect(trackingEnabled()).toBe(false);
  });
});

describe("clampStick", () => {
  it("clamps and rejects junk", () => {
    expect(clampStick(2)).toBe(1);
    expect(clampStick(-3)).toBe(-1);
    expect(clampStick("nope")).toBe(0);
  });
});
