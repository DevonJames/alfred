/**
 * Convert iPhone HEIC/HEIF to JPEG. Vision APIs and Chromium cannot read HEIC.
 * Uses macOS `sips`, which understands the HEIC variants Photos writes.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HEIC_BRANDS = new Set(["heic", "heix", "heif", "hevc", "hevx", "mif1", "msf1"]);

export interface PreparedPhoto {
  bytes: Buffer;
  mimeType: string;
  convertedFrom?: string;
}

export function isHeicMime(mimeType?: string): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  return mime === "image/heic" || mime === "image/heif" || mime === "image/heic-sequence";
}

export function isHeicFilename(filename?: string): boolean {
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  return ext === "heic" || ext === "heif";
}

function alreadyVisionSafe(bytes: Buffer): boolean {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return true;
  if (bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  if (bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return true;
  }
  if (bytes.byteLength >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF87a") return true;
  if (bytes.byteLength >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF89a") return true;
  return false;
}

export function looksLikeHeic(bytes: Buffer, filename?: string, mimeType?: string): boolean {
  if (alreadyVisionSafe(bytes)) return false;
  if (isHeicFilename(filename) || isHeicMime(mimeType)) return true;
  if (bytes.byteLength < 12) return false;
  if (bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  const brand = bytes.subarray(8, 12).toString("ascii").toLowerCase();
  return HEIC_BRANDS.has(brand);
}

export async function convertHeicToJpeg(bytes: Buffer, filename = "photo.heic"): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "alfred-heic-"));
  const src = path.join(dir, path.basename(filename) || "in.heic");
  const dest = path.join(dir, "out.jpg");
  try {
    await writeFile(src, bytes);
    try {
      await execFileAsync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", src, "--out", dest], {
        timeout: 60_000,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not convert ${filename} from HEIC to JPEG. Alfred uses macOS sips for iPhone photos. ${detail}`,
      );
    }
    const jpeg = await readFile(dest);
    if (jpeg.byteLength < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new Error(`HEIC conversion for ${filename} did not produce a JPEG`);
    }
    return jpeg;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function preparePhotoForVision(opts: {
  filename: string;
  bytes: Buffer;
  mimeType?: string;
}): Promise<PreparedPhoto> {
  if (!looksLikeHeic(opts.bytes, opts.filename, opts.mimeType)) {
    return {
      bytes: opts.bytes,
      mimeType: opts.mimeType || "image/jpeg",
    };
  }
  const jpeg = await convertHeicToJpeg(opts.bytes, opts.filename);
  return {
    bytes: jpeg,
    mimeType: "image/jpeg",
    convertedFrom: opts.mimeType || "image/heic",
  };
}
