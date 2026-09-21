import { describe, expect, it } from "vitest";
import { motorByte, stickToWheelBytes, stopBytes, WHEEL_SPEEDS } from "./wheels.js";

const LEFT = 0x00;
const RIGHT = 0x80;
const BACK = 0x40;
const L3 = WHEEL_SPEEDS[3];

describe("stickToWheelBytes", () => {
  it("matches alfred_cli stop", () => {
    expect(stopBytes()).toEqual({ left: LEFT, right: RIGHT });
    expect(stickToWheelBytes({ left: 0, right: 0 })).toEqual(stopBytes());
    expect(stickToWheelBytes({ left: 0.05, right: -0.04 })).toEqual(stopBytes());
  });

  it("maps both sticks up to the old SSH forward at level 3", () => {
    expect(stickToWheelBytes({ left: 1, right: 1 })).toEqual({
      left: LEFT | L3,
      right: RIGHT | L3,
    });
  });

  it("maps both sticks down to backward", () => {
    expect(stickToWheelBytes({ left: -1, right: -1 })).toEqual({
      left: LEFT | BACK | L3,
      right: RIGHT | BACK | L3,
    });
  });

  it("turns when one stick is up and the other is centered (old left/right)", () => {
    // right motor only → SSH "left"
    expect(stickToWheelBytes({ left: 0, right: 1 })).toEqual({
      left: LEFT,
      right: RIGHT | L3,
    });
    // left motor only → SSH "right"
    expect(stickToWheelBytes({ left: 1, right: 0 })).toEqual({
      left: LEFT | L3,
      right: RIGHT,
    });
  });

  it("rotates when the sticks oppose (old spinLeft / spinRight)", () => {
    expect(stickToWheelBytes({ left: -1, right: 1 })).toEqual({
      left: LEFT | BACK | L3,
      right: RIGHT | L3,
    });
    expect(stickToWheelBytes({ left: 1, right: -1 })).toEqual({
      left: LEFT | L3,
      right: RIGHT | BACK | L3,
    });
  });

  it("scales partial throw below full speed", () => {
    const half = stickToWheelBytes({ left: 0.5, right: 0.5 });
    expect(half.left & 0x3f).toBe(Math.round(0.5 * L3));
    expect(half.right & 0x3f).toBe(Math.round(0.5 * L3));
    expect(half.left & BACK).toBe(0);
  });
});

describe("motorByte", () => {
  it("caps speed at 63", () => {
    expect(motorByte(LEFT, 1, 99) & 0x3f).toBe(63);
  });
});
