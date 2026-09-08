import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { convertHeicToJpeg, looksLikeHeic, preparePhotoForVision } from "./photo-heic.js";

const execFileAsync = promisify(execFile);

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function heicHeader(brand: string): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(0, 0);
  buf.write("ftyp", 4, "ascii");
  buf.write(brand, 8, "ascii");
  return buf;
}

describe("HEIC photo conversion", () => {
  it("detects HEIC from filename, mime, and ftyp brand", () => {
    expect(looksLikeHeic(Buffer.from("nope"), "IMG_1721.HEIC")).toBe(true);
    expect(looksLikeHeic(Buffer.from("nope"), "shot.jpg", "image/heic")).toBe(true);
    expect(looksLikeHeic(heicHeader("heic"))).toBe(true);
    expect(looksLikeHeic(heicHeader("mif1"))).toBe(true);
    expect(looksLikeHeic(PNG_1X1, "IMG_1721.HEIC")).toBe(false);
    expect(looksLikeHeic(Buffer.from([0xff, 0xd8, 0xff]), "IMG_1721.HEIC")).toBe(false);
  });

  it("leaves JPEG bytes unchanged", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const prepared = await preparePhotoForVision({
      filename: "IMG_1721.HEIC",
      bytes: jpeg,
      mimeType: "image/heic",
    });
    expect(prepared.convertedFrom).toBeUndefined();
    expect(prepared.bytes).toEqual(jpeg);
  });

  it("converts a sips HEIC back to JPEG", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alfred-heic-test-"));
    try {
      const pngPath = path.join(dir, "in.png");
      const heicPath = path.join(dir, "in.heic");
      await writeFile(pngPath, PNG_1X1);
      await execFileAsync("sips", ["-s", "format", "heic", pngPath, "--out", heicPath], { timeout: 20_000 });
      const heic = await readFile(heicPath);
      expect(looksLikeHeic(heic, "in.heic")).toBe(true);
      const jpeg = await convertHeicToJpeg(heic, "in.heic");
      expect(jpeg[0]).toBe(0xff);
      expect(jpeg[1]).toBe(0xd8);
      const prepared = await preparePhotoForVision({
        filename: "IMG_1721.HEIC",
        bytes: heic,
        mimeType: "image/heic",
      });
      expect(prepared.mimeType).toBe("image/jpeg");
      expect(prepared.convertedFrom).toBe("image/heic");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
