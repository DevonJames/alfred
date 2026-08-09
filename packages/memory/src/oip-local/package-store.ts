import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBytes, canonicalJsonString } from "./canonical-json.js";
import { hashBytes, hashToFilename, type TaggedHash } from "./hashing.js";
import { newLogicalId, toMemoryDid, type MemoryDid } from "./ids.js";
import {
  PackageManifestSchema,
  STORAGE_FORMAT_VERSION,
  StorageFormatSchema,
  type MemoryRecordType,
  type MemoryRevision,
  type PackageManifest,
  type StorageFormat,
} from "./schemas.js";

export interface CreatePackageInput {
  type: MemoryRecordType;
  /** Partial revision body without id/revision/previousRevision. */
  body: Omit<
    MemoryRevision,
    "id" | "revision" | "previousRevision" | "type" | "createdAt" | "updatedAt"
  > &
    Partial<Pick<MemoryRevision, "createdAt" | "updatedAt" | "learnedAt">>;
  logicalId?: string;
  now?: string;
}

export class PackageStore {
  constructor(readonly rootDir: string) {}

  get memoryDir(): string {
    return path.join(this.rootDir, "memory");
  }

  get packagesDir(): string {
    return path.join(this.memoryDir, "packages");
  }

  get storageFormatPath(): string {
    return path.join(this.rootDir, "storage-format.json");
  }

  packageDir(logicalId: string): string {
    return path.join(this.packagesDir, logicalId);
  }

  revisionsDir(logicalId: string): string {
    return path.join(this.packageDir(logicalId), "revisions");
  }

  revisionPath(logicalId: string, revision: TaggedHash): string {
    return path.join(this.revisionsDir(logicalId), `${hashToFilename(revision)}.json`);
  }

  manifestPath(logicalId: string): string {
    return path.join(this.packageDir(logicalId), "manifest.json");
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.packagesDir, { recursive: true });
    await mkdir(path.join(this.rootDir, "artifacts", "sha256"), { recursive: true });
    await mkdir(path.join(this.rootDir, "indexes"), { recursive: true });
    if (!(await exists(this.storageFormatPath))) {
      const format: StorageFormat = {
        version: STORAGE_FORMAT_VERSION,
        hashAlgorithm: "sha256",
        createdAt: new Date().toISOString(),
        description: "Alfred OIP-local memory store",
      };
      await atomicWriteJson(this.storageFormatPath, format);
    } else {
      StorageFormatSchema.parse(JSON.parse(await readFile(this.storageFormatPath, "utf8")));
    }
  }

  async createPackage(input: CreatePackageInput): Promise<MemoryRevision> {
    await this.ensureRoot();
    const logicalId = input.logicalId ?? newLogicalId();
    const did = toMemoryDid(logicalId);
    const now = input.now ?? new Date().toISOString();
    const dir = this.packageDir(logicalId);
    if (await exists(dir)) {
      throw new Error(`Package already exists: ${did}`);
    }

    const draft = {
      ...input.body,
      id: did,
      type: input.type,
      revision: "",
      previousRevision: null,
      schema: input.body.schema ?? Object.create(null),
      alfred: input.body.alfred ?? Object.create(null),
      drefs: input.body.drefs ?? Object.create(null),
      provenance: input.body.provenance ?? Object.create(null),
      createdAt: input.body.createdAt ?? now,
      updatedAt: input.body.updatedAt ?? now,
      learnedAt: input.body.learnedAt ?? now,
    } as MemoryRevision;

    const revision = hashBytes(canonicalJsonBytes(draft));
    const record: MemoryRevision = { ...draft, revision };

    await mkdir(this.revisionsDir(logicalId), { recursive: true });
    await atomicWriteJson(this.revisionPath(logicalId, revision), record);

    const manifest: PackageManifest = {
      id: did,
      type: input.type,
      currentRevision: revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    await atomicWriteJson(this.manifestPath(logicalId), manifest);

    const readme = `# ${input.type} ${did}\n\n${labelFor(record)}\n`;
    await writeFile(path.join(dir, "README.md"), readme, "utf8");
    await atomicWriteJson(path.join(dir, "artifact-refs.json"), { artifacts: [] });

    return record;
  }

  async appendRevision(
    didOrLogicalId: string,
    patch: Partial<MemoryRevision>,
    now = new Date().toISOString(),
  ): Promise<MemoryRevision> {
    const logicalId = stripDid(didOrLogicalId);
    const current = await this.readCurrent(logicalId);
    if (!current) throw new Error(`Package not found: ${didOrLogicalId}`);

    const draft: MemoryRevision = {
      ...current,
      ...patch,
      id: current.id,
      type: patch.type ?? current.type,
      revision: "",
      previousRevision: current.revision,
      createdAt: current.createdAt,
      updatedAt: now,
      schema: patch.schema ?? current.schema ?? {},
      alfred: { ...(current.alfred ?? {}), ...(patch.alfred ?? {}) },
      drefs: { ...(current.drefs ?? {}), ...(patch.drefs ?? {}) },
      provenance: { ...(current.provenance ?? {}), ...(patch.provenance ?? {}) },
    };

    const revision = hashBytes(canonicalJsonBytes(draft));
    const record: MemoryRevision = { ...draft, revision };

    // Immutability: refuse overwrite of existing revision file
    const revPath = this.revisionPath(logicalId, revision);
    if (await exists(revPath)) {
      // Identical content — treat as no-op return of existing
      return JSON.parse(await readFile(revPath, "utf8")) as MemoryRevision;
    }
    await atomicWriteJson(revPath, record);

    const manifest = await this.readManifest(logicalId);
    if (!manifest) throw new Error(`Missing manifest for ${logicalId}`);
    manifest.currentRevision = revision;
    manifest.updatedAt = now;
    await atomicWriteJson(this.manifestPath(logicalId), manifest);

    return record;
  }

  async readManifest(logicalId: string): Promise<PackageManifest | null> {
    const p = this.manifestPath(stripDid(logicalId));
    if (!(await exists(p))) return null;
    return PackageManifestSchema.parse(JSON.parse(await readFile(p, "utf8")));
  }

  async readCurrent(logicalId: string): Promise<MemoryRevision | null> {
    const manifest = await this.readManifest(logicalId);
    if (!manifest) return null;
    return this.readRevision(stripDid(logicalId), manifest.currentRevision as TaggedHash);
  }

  async readRevision(logicalId: string, revision: TaggedHash): Promise<MemoryRevision | null> {
    const p = this.revisionPath(stripDid(logicalId), revision);
    if (!(await exists(p))) return null;
    return JSON.parse(await readFile(p, "utf8")) as MemoryRevision;
  }

  async listLogicalIds(): Promise<string[]> {
    await this.ensureRoot();
    const entries = await readdir(this.packagesDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  async listRevisions(logicalId: string): Promise<TaggedHash[]> {
    const dir = this.revisionsDir(stripDid(logicalId));
    const files = await readdir(dir).catch(() => []);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const base = f.replace(/\.json$/, "");
        const idx = base.indexOf("-");
        return `${base.slice(0, idx)}:${base.slice(idx + 1)}` as TaggedHash;
      });
  }

  async deletePackage(didOrLogicalId: string): Promise<void> {
    const logicalId = stripDid(didOrLogicalId);
    await rm(this.packageDir(logicalId), { recursive: true, force: true });
  }

  async *iterateCurrentRevisions(): AsyncGenerator<MemoryRevision> {
    for (const id of await this.listLogicalIds()) {
      const rev = await this.readCurrent(id);
      if (rev) yield rev;
    }
  }
}

function stripDid(didOrLogicalId: string): string {
  return didOrLogicalId.startsWith("did:memory:")
    ? didOrLogicalId.slice("did:memory:".length).split("#")[0]!
    : didOrLogicalId;
}

function labelFor(record: MemoryRevision): string {
  if (record.name) return record.name;
  if (typeof record.schema?.name === "string") return String(record.schema.name);
  if (record.text) return record.text;
  return record.type;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = `${canonicalJsonString(value)}\n`;
  // For human-readable manifests/revisions, pretty-print after hashing is done.
  // Revision files should store the record with its final revision field.
  const pretty =
    typeof value === "object" && value !== null
      ? `${JSON.stringify(value, null, 2)}\n`
      : body;
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, pretty, "utf8");
  await rename(tmp, filePath);
}

export type { MemoryDid };
