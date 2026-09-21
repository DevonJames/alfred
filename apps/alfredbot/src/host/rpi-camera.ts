import { spawn, type ChildProcess } from "node:child_process";
import { writeCameraFrame } from "./camera-sink.js";

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

export type CameraStatus = {
  running: boolean;
  source: "rpicam" | "none";
  preview: boolean;
  hasFrame: boolean;
  error: string | null;
  rotation: number;
};

let proc: ChildProcess | null = null;
let latest: Buffer | null = null;
let lastError: string | null = null;
let buffer: Buffer = Buffer.alloc(0);
let previewOnly = false;

function rotation(): number {
  const raw = Number(process.env.ALFRED_CAMERA_ROTATION ?? 0);
  return [0, 90, 180, 270].includes(raw) ? raw : 0;
}

export function extractJpegFrames(chunk: Buffer, pending: Buffer): { frames: Buffer[]; rest: Buffer } {
  let acc = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
  const frames: Buffer[] = [];
  for (;;) {
    const start = acc.indexOf(JPEG_SOI);
    if (start < 0) {
      return { frames, rest: acc.length > 1 ? acc.subarray(acc.length - 1) : Buffer.alloc(0) };
    }
    const end = acc.indexOf(JPEG_EOI, start + 2);
    if (end < 0) {
      return { frames, rest: start > 0 ? acc.subarray(start) : acc };
    }
    frames.push(acc.subarray(start, end + 2));
    acc = acc.subarray(end + 2);
  }
}

export function getLatestJpeg(): Buffer | null {
  return latest;
}

export function cameraStatus(): CameraStatus {
  return {
    running: Boolean(proc),
    source: proc ? "rpicam" : "none",
    preview: previewOnly,
    hasFrame: Boolean(latest),
    error: lastError,
    rotation: rotation(),
  };
}

function shouldUseRpicam(): boolean {
  return process.env.ALFREDBOT_ENABLE_RPI_CAMERA === "1";
}

export function stopCamera(): CameraStatus {
  const child = proc;
  proc = null;
  previewOnly = false;
  latest = null;
  buffer = Buffer.alloc(0);
  lastError = null;
  if (child && !child.killed) child.kill("SIGTERM");
  return cameraStatus();
}

export function ensureCamera(opts?: { preview?: boolean }): CameraStatus {
  if (proc) return cameraStatus();
  const preview = opts?.preview === true;
  if (!preview && !shouldUseRpicam()) {
    lastError = null;
    return cameraStatus();
  }

  const bin = process.env.ALFRED_CAMERA_BIN ?? "rpicam-vid";
  const fps = preview
    ? (process.env.ALFRED_CAMERA_PREVIEW_FPS ?? "5")
    : (process.env.ALFRED_CAMERA_FPS ?? "10");
  const width = preview
    ? (process.env.ALFRED_CAMERA_PREVIEW_WIDTH ?? "320")
    : (process.env.ALFRED_CAMERA_WIDTH ?? "1024");
  const height = preview
    ? (process.env.ALFRED_CAMERA_PREVIEW_HEIGHT ?? "240")
    : (process.env.ALFRED_CAMERA_HEIGHT ?? "768");
  const quality = preview
    ? (process.env.ALFRED_CAMERA_PREVIEW_QUALITY ?? "40")
    : (process.env.ALFRED_CAMERA_QUALITY ?? "50");
  const args = [
    "--codec",
    "mjpeg",
    "--inline",
    "--flush",
    "-t",
    "0",
    "-n",
    "--framerate",
    fps,
    "--width",
    width,
    "--height",
    height,
    "--quality",
    quality,
    "--camera",
    "0",
    ...(process.env.ALFRED_CAMERA_HFLIP === "1" ? ["--hflip"] : []),
    ...(process.env.ALFRED_CAMERA_VFLIP === "1" ? ["--vflip"] : []),
    "-o",
    "-",
  ];

  let child: ChildProcess;
  try {
    child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    proc = null;
    return cameraStatus();
  }

  proc = child;
  previewOnly = preview;
  lastError = null;
  buffer = Buffer.alloc(0);
  console.log(`[camera] spawned ${bin} pid=${child.pid} preview=${preview}`);

  child.stdout?.on("data", (chunk: Buffer) => {
    const parsed = extractJpegFrames(chunk, buffer);
    buffer = parsed.rest;
    const frame = parsed.frames.at(-1);
    if (!frame) return;
    const first = !latest;
    latest = frame;
    if (first) console.log(`[camera] first frame bytes=${frame.length} preview=${previewOnly}`);
    // Preview is for the phone Head tab only — do not feed the face tracker.
    if (!previewOnly) writeCameraFrame(frame);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (!msg) return;
    const fatal = /error|failed|unable|not found|no cameras/i.test(msg);
    if (fatal) lastError = msg;
  });
  child.on("error", (err) => {
    lastError = err.message;
    if (proc === child) proc = null;
  });
  child.on("exit", () => {
    if (proc === child) {
      proc = null;
      previewOnly = false;
    }
    buffer = Buffer.alloc(0);
  });

  return cameraStatus();
}

export async function waitForCameraFrame(ms = 1800): Promise<CameraStatus> {
  const deadline = Date.now() + ms;
  let status = cameraStatus();
  while (Date.now() < deadline) {
    if (status.hasFrame || status.error || !status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = cameraStatus();
  }
  return status;
}
