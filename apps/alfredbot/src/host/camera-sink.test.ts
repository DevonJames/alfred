import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isJpeg, writeCameraFrame } from "./camera-sink.js";

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

describe("camera frame sink", () => {
  const dirs: string[] = [];

  afterEach(() => {
    delete process.env.ALFREDBOT_CAMERA_FRAME_SINK;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("accepts JPEG SOI bytes", () => {
    expect(isJpeg(jpeg)).toBe(true);
    expect(isJpeg(Uint8Array.from([0x00, 0x01]))).toBe(false);
  });

  it("writes atomically to the configured path", () => {
    const dir = mkdtempSync(join(tmpdir(), "alfredbot-sink-"));
    dirs.push(dir);
    const dest = join(dir, "latest.jpg");
    process.env.ALFREDBOT_CAMERA_FRAME_SINK = dest;
    expect(writeCameraFrame(jpeg)).toEqual({ ok: true, path: dest });
    expect(readFileSync(dest)).toEqual(Buffer.from(jpeg));
  });

  it("can be disabled with an empty sink path", () => {
    process.env.ALFREDBOT_CAMERA_FRAME_SINK = "";
    expect(writeCameraFrame(jpeg)).toEqual({ ok: false, path: null });
  });
});
