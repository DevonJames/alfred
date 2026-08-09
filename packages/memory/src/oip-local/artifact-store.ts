import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { hashBytes, hashShardPath, hashToFilename, parseTaggedHash, type TaggedHash } from "./hashing.js";

export interface StoredArtifact {
  contentHash: TaggedHash;
  storedAt: string;
  byteSize: number;
  mimeType?: string;
  originalFilename?: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

export class ArtifactStore {
  constructor(readonly rootDir: string) {}

  get artifactsRoot(): string {
    return path.join(this.rootDir, "artifacts", "sha256");
  }

  relativePathFor(hash: TaggedHash, ext = ""): string {
    const { hex } = parseTaggedHash(hash);
    const shard = hashShardPath(hex);
    const base = hashToFilename(hash);
    const suffix = ext.startsWith(".") || !ext ? ext : `.${ext}`;
    return path.posix.join("artifacts", "sha256", shard, `${base}${suffix}`);
  }

  absolutePathFor(hash: TaggedHash, ext = ""): string {
    return path.join(this.rootDir, this.relativePathFor(hash, ext));
  }

  async putBytes(
    bytes: Buffer | Uint8Array,
    opts: { mimeType?: string; originalFilename?: string; ext?: string } = {},
  ): Promise<StoredArtifact> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const contentHash = hashBytes(buf);
    const ext =
      opts.ext ??
      (opts.originalFilename ? path.extname(opts.originalFilename) : guessExt(opts.mimeType));
    const relative = this.relativePathFor(contentHash, ext);
    const absolutePath = path.join(this.rootDir, relative);

    if (!existsSync(absolutePath)) {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      const tmp = `${absolutePath}.${process.pid}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, absolutePath);
    }

    return {
      contentHash,
      storedAt: relative,
      byteSize: buf.byteLength,
      mimeType: opts.mimeType,
      originalFilename: opts.originalFilename,
      absolutePath,
    };
  }

  async putFile(
    sourcePath: string,
    opts: { mimeType?: string; originalFilename?: string } = {},
  ): Promise<StoredArtifact> {
    const bytes = await readFile(sourcePath);
    return this.putBytes(bytes, {
      mimeType: opts.mimeType,
      originalFilename: opts.originalFilename ?? path.basename(sourcePath),
      ext: path.extname(opts.originalFilename ?? sourcePath),
    });
  }

  async verify(hash: TaggedHash, absolutePath?: string): Promise<boolean> {
    const filePath = absolutePath ?? (await this.findAbsolute(hash));
    if (!filePath || !existsSync(filePath)) return false;
    const bytes = await readFile(filePath);
    return hashBytes(bytes) === hash;
  }

  async findAbsolute(hash: TaggedHash): Promise<string | null> {
    const { hex } = parseTaggedHash(hash);
    const shard = hashShardPath(hex);
    const dir = path.join(this.artifactsRoot, shard);
    const base = hashToFilename(hash);
    try {
      const files = await readdir(dir);
      const match = files.find((f) => f === base || f.startsWith(`${base}.`));
      return match ? path.join(dir, match) : null;
    } catch {
      return null;
    }
  }

  /** Stream-hash a file without loading it entirely (for large artifacts). */
  async hashFile(filePath: string): Promise<TaggedHash> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
    });
  }
}

function guessExt(mimeType?: string): string {
  if (!mimeType) return "";
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/heic": ".heic",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
  };
  return map[mimeType] ?? "";
}
