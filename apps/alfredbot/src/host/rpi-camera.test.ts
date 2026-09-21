import { describe, expect, it } from "vitest";
import { extractJpegFrames, waitForCameraFrame } from "./rpi-camera.js";

const frame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

describe("extractJpegFrames", () => {
  it("pulls a complete JPEG out of a stream chunk", () => {
    const { frames, rest } = extractJpegFrames(frame, Buffer.alloc(0));
    expect(frames).toEqual([frame]);
    expect(rest.length).toBe(0);
  });

  it("holds a partial JPEG until the end marker arrives", () => {
    const first = extractJpegFrames(frame.subarray(0, 4), Buffer.alloc(0));
    expect(first.frames).toEqual([]);
    const second = extractJpegFrames(frame.subarray(4), first.rest);
    expect(second.frames).toEqual([frame]);
  });
});

describe("waitForCameraFrame", () => {
  it("returns immediately when the camera is not running", async () => {
    const status = await waitForCameraFrame(200);
    expect(status.running).toBe(false);
    expect(status.hasFrame).toBe(false);
  });
});
