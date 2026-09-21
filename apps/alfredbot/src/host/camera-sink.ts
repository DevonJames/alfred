import { renameSync, writeFileSync } from "node:fs";

const JPEG_SOI0 = 0xff;
const JPEG_SOI1 = 0xd8;
const MAX_JPEG_BYTES = 2_000_000;

export function cameraFrameSinkPath(): string | null {
  const raw = process.env.ALFREDBOT_CAMERA_FRAME_SINK;
  if (raw === "") return null;
  return raw ?? "/tmp/alfred-camera-latest.jpg";
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === JPEG_SOI0 && bytes[1] === JPEG_SOI1;
}

/**
 * Atomically write the latest JPEG for the existing face-tracker daemon.
 * Same path Electron used (`/tmp/alfred-camera-latest.jpg`). Failures never throw.
 */
export function writeCameraFrame(jpeg: Uint8Array): { ok: boolean; path: string | null } {
  const dest = cameraFrameSinkPath();
  if (!dest) return { ok: false, path: null };
  if (!isJpeg(jpeg) || jpeg.length > MAX_JPEG_BYTES) return { ok: false, path: dest };
  try {
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, jpeg);
    renameSync(tmp, dest);
    return { ok: true, path: dest };
  } catch {
    return { ok: false, path: dest };
  }
}
