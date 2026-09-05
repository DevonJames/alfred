/**
 * Alfred Memory File — single-file OIP package+artifact bundle for node-to-node merge.
 *
 * Format: zip containing:
 *   bundle.json
 *   storage-format.json
 *   memory/packages/<logicalId>/...
 *   artifacts/sha256/...
 * Indexes are never included (rebuild after merge).
 */

import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { computeRevisionHash } from "./integrity.js";
import { PackageStore } from "./package-store.js";
import { OipLocalMemoryProvider } from "./provider.js";
import {
  PackageManifestSchema,
  type MemoryRevision,
  type PackageManifest,
} from "./schemas.js";

export const ALFRED_MEMORY_BUNDLE_FORMAT = "alfred-memory" as const;
export const ALFRED_MEMORY_BUNDLE_VERSION = 1 as const;
export const ALFRED_MEMORY_BUNDLE_EXT = ".alfred-memory.zip";

export interface AlfredMemoryBundleManifest {
  format: typeof ALFRED_MEMORY_BUNDLE_FORMAT;
  version: typeof ALFRED_MEMORY_BUNDLE_VERSION;
  exportedAt: string;
  profileId?: string;
  packageCount: number;
  artifactFileCount: number;
}

export interface AlfredMemoryMergeReport {
  packagesAdded: number;
  packagesMerged: number;
  packagesUnchanged: number;
  revisionsAdded: number;
  artifactsAdded: number;
  artifactsSkipped: number;
  currentHeadUpdates: number;
  errors: string[];
  root: string;
}

function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

function toPosixRel(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

/** Export local OIP root to a single .alfred-memory.zip file. */
export async function exportAlfredMemoryBundle(opts: {
  rootDir: string;
  outPath: string;
  profileId?: string;
}): Promise<{
  outPath: string;
  packageCount: number;
  artifactFileCount: number;
  byteSize: number;
}> {
  const root = path.resolve(opts.rootDir);
  const packagesDir = path.join(root, "memory", "packages");
  const artifactsDir = path.join(root, "artifacts");
  const storageFormatPath = path.join(root, "storage-format.json");

  if (!(await exists(packagesDir))) {
    throw new Error(`No OIP packages at ${packagesDir}`);
  }

  const files: Record<string, Uint8Array> = {};
  let packageCount = 0;
  let artifactFileCount = 0;

  if (await exists(packagesDir)) {
    const ids = await readdir(packagesDir, { withFileTypes: true });
    for (const e of ids) {
      if (!e.isDirectory()) continue;
      packageCount += 1;
      const pkgDir = path.join(packagesDir, e.name);
      for (const abs of await listFilesRecursive(pkgDir)) {
        const rel = toPosixRel(root, abs);
        files[rel] = await readFile(abs);
      }
    }
  }

  if (await exists(artifactsDir)) {
    for (const abs of await listFilesRecursive(artifactsDir)) {
      // Skip sidecar junk
      if (abs.endsWith(".tmp")) continue;
      artifactFileCount += 1;
      const rel = toPosixRel(root, abs);
      files[rel] = await readFile(abs);
    }
  }

  if (await exists(storageFormatPath)) {
    files["storage-format.json"] = await readFile(storageFormatPath);
  }

  const bundleManifest: AlfredMemoryBundleManifest = {
    format: ALFRED_MEMORY_BUNDLE_FORMAT,
    version: ALFRED_MEMORY_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    profileId: opts.profileId,
    packageCount,
    artifactFileCount,
  };
  files["bundle.json"] = strToU8(`${JSON.stringify(bundleManifest, null, 2)}\n`);

  const zipped = zipSync(files, { level: 6 });
  const outPath = path.resolve(opts.outPath);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.from(zipped));
  const st = await stat(outPath);
  return {
    outPath,
    packageCount,
    artifactFileCount,
    byteSize: st.size,
  };
}

/** Extract zip bytes to a temp directory; returns path to bundle root. */
export async function extractAlfredMemoryBundle(
  zipBytes: Buffer | Uint8Array,
  destDir?: string,
): Promise<string> {
  const unzipped = unzipSync(zipBytes instanceof Buffer ? zipBytes : Buffer.from(zipBytes));
  const dest = destDir ?? (await mkdtemp(path.join(tmpdir(), "alfred-memory-")));
  await mkdir(dest, { recursive: true });

  for (const [name, data] of Object.entries(unzipped)) {
    if (name.endsWith("/")) continue;
    const target = path.join(dest, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  return resolveBundleRoot(dest);
}

async function resolveBundleRoot(extracted: string): Promise<string> {
  if (await exists(path.join(extracted, "memory", "packages"))) return extracted;
  if (await exists(path.join(extracted, "bundle.json"))) return extracted;
  // Nested single folder
  const entries = await readdir(extracted, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    const nested = path.join(extracted, dirs[0]!.name);
    if (
      (await exists(path.join(nested, "memory", "packages"))) ||
      (await exists(path.join(nested, "bundle.json")))
    ) {
      return nested;
    }
  }
  return extracted;
}

function pickNewerManifest(
  local: PackageManifest,
  remote: PackageManifest,
): { manifest: PackageManifest; headChanged: boolean } {
  const localMs = Date.parse(local.updatedAt) || 0;
  const remoteMs = Date.parse(remote.updatedAt) || 0;
  let currentRevision = local.currentRevision;
  let headChanged = false;
  if (remoteMs > localMs) {
    currentRevision = remote.currentRevision;
    headChanged = remote.currentRevision !== local.currentRevision;
  } else if (remoteMs === localMs && remote.currentRevision !== local.currentRevision) {
    // Tie-break: keep local head, but still import remote revision files.
    currentRevision = local.currentRevision;
  }
  const createdAt =
    Date.parse(local.createdAt) <= Date.parse(remote.createdAt)
      ? local.createdAt
      : remote.createdAt;
  const updatedAt = remoteMs >= localMs ? remote.updatedAt : local.updatedAt;
  return {
    manifest: {
      id: local.id,
      type: local.type,
      currentRevision,
      createdAt,
      updatedAt,
    },
    headChanged,
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

/**
 * Union-merge a remote OIP tree into the local root.
 * Never deletes local-only packages. Preserves revision hashes/files.
 */
export async function mergeAlfredMemoryFromDir(opts: {
  localRoot: string;
  remoteRoot: string;
  rebuildIndexes?: boolean;
}): Promise<AlfredMemoryMergeReport> {
  const localRoot = path.resolve(opts.localRoot);
  const remoteRoot = path.resolve(opts.remoteRoot);
  const report: AlfredMemoryMergeReport = {
    packagesAdded: 0,
    packagesMerged: 0,
    packagesUnchanged: 0,
    revisionsAdded: 0,
    artifactsAdded: 0,
    artifactsSkipped: 0,
    currentHeadUpdates: 0,
    errors: [],
    root: localRoot,
  };

  const localPackages = new PackageStore(localRoot);
  await localPackages.ensureRoot();

  const remotePackagesDir = path.join(remoteRoot, "memory", "packages");
  if (!(await exists(remotePackagesDir))) {
    throw new Error(`Bundle has no memory/packages at ${remotePackagesDir}`);
  }

  const remoteIds = (await readdir(remotePackagesDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const logicalId of remoteIds) {
    const remotePkg = path.join(remotePackagesDir, logicalId);
    const localPkg = localPackages.packageDir(logicalId);

    if (!(await exists(localPkg))) {
      await cp(remotePkg, localPkg, { recursive: true });
      report.packagesAdded += 1;
      continue;
    }

    // Merge revisions file-by-file (hash-preserving).
    let addedRevs = 0;
    const remoteRevsDir = path.join(remotePkg, "revisions");
    const localRevsDir = path.join(localPkg, "revisions");
    await mkdir(localRevsDir, { recursive: true });
    const revFiles = (await readdir(remoteRevsDir).catch(() => [])).filter((f) =>
      f.endsWith(".json"),
    );

    for (const file of revFiles) {
      const remoteRevPath = path.join(remoteRevsDir, file);
      const localRevPath = path.join(localRevsDir, file);
      if (await exists(localRevPath)) {
        const [a, b] = await Promise.all([
          readFile(remoteRevPath),
          readFile(localRevPath),
        ]);
        if (!a.equals(b)) {
          report.errors.push(
            `Revision conflict for ${logicalId}/${file}: local and remote bytes differ`,
          );
        }
        continue;
      }
      try {
        const raw = JSON.parse(await readFile(remoteRevPath, "utf8")) as MemoryRevision;
        const expected = computeRevisionHash(raw);
        if (raw.revision && raw.revision !== expected) {
          report.errors.push(
            `Skipping ${logicalId}/${file}: revision hash mismatch (got ${raw.revision}, expected ${expected})`,
          );
          continue;
        }
        await copyFile(remoteRevPath, localRevPath);
        addedRevs += 1;
        report.revisionsAdded += 1;
      } catch (err) {
        report.errors.push(
          `Failed to import ${logicalId}/${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Prefer newer manifest head; never drop either side's revision files.
    const remoteManifestPath = path.join(remotePkg, "manifest.json");
    const localManifestPath = path.join(localPkg, "manifest.json");
    if ((await exists(remoteManifestPath)) && (await exists(localManifestPath))) {
      try {
        const remoteMan = PackageManifestSchema.parse(
          JSON.parse(await readFile(remoteManifestPath, "utf8")),
        );
        const localMan = PackageManifestSchema.parse(
          JSON.parse(await readFile(localManifestPath, "utf8")),
        );
        const { manifest, headChanged } = pickNewerManifest(localMan, remoteMan);
        // Ensure chosen head revision exists locally
        const headFile = localPackages.revisionPath(
          logicalId,
          manifest.currentRevision as import("./hashing.js").TaggedHash,
        );
        if (!(await exists(headFile))) {
          // Fall back to local head if remote head file didn't copy
          manifest.currentRevision = localMan.currentRevision;
        }
        await writeJsonAtomic(localManifestPath, manifest);
        if (headChanged && manifest.currentRevision !== localMan.currentRevision) {
          report.currentHeadUpdates += 1;
        }
      } catch (err) {
        report.errors.push(
          `Manifest merge failed for ${logicalId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Best-effort: copy missing non-revision package files (README, artifact-refs)
    for (const name of ["README.md", "artifact-refs.json"]) {
      const remoteFile = path.join(remotePkg, name);
      const localFile = path.join(localPkg, name);
      if ((await exists(remoteFile)) && !(await exists(localFile))) {
        await copyFile(remoteFile, localFile);
      }
    }

    if (addedRevs > 0) report.packagesMerged += 1;
    else report.packagesUnchanged += 1;
  }

  // Artifacts: content-addressed copy-if-missing
  const remoteArtifacts = path.join(remoteRoot, "artifacts");
  const localArtifacts = path.join(localRoot, "artifacts");
  if (await exists(remoteArtifacts)) {
    await mkdir(localArtifacts, { recursive: true });
    for (const abs of await listFilesRecursive(remoteArtifacts)) {
      if (abs.endsWith(".tmp")) continue;
      const rel = toPosixRel(remoteRoot, abs);
      const dest = path.join(localRoot, rel);
      if (await exists(dest)) {
        report.artifactsSkipped += 1;
        continue;
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(abs, dest);
      report.artifactsAdded += 1;
    }
  }

  // storage-format: keep local if present
  const remoteSf = path.join(remoteRoot, "storage-format.json");
  const localSf = path.join(localRoot, "storage-format.json");
  if ((await exists(remoteSf)) && !(await exists(localSf))) {
    await copyFile(remoteSf, localSf);
  }

  if (opts.rebuildIndexes !== false) {
    const provider = new OipLocalMemoryProvider(localRoot);
    await provider.rebuildIndexes();
  }

  return report;
}

/** Merge a .alfred-memory.zip into the local OIP root. */
export async function mergeAlfredMemoryBundle(opts: {
  localRoot: string;
  zipPath?: string;
  zipBytes?: Buffer | Uint8Array;
  rebuildIndexes?: boolean;
}): Promise<AlfredMemoryMergeReport> {
  let bytes: Buffer;
  if (opts.zipBytes) {
    bytes = Buffer.isBuffer(opts.zipBytes) ? opts.zipBytes : Buffer.from(opts.zipBytes);
  } else if (opts.zipPath) {
    bytes = await readFile(path.resolve(opts.zipPath));
  } else {
    throw new Error("Provide zipPath or zipBytes");
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "alfred-memory-merge-"));
  try {
    // Extract into tmp/contents so we can delete the whole tree cleanly
    const extractDir = path.join(tmp, "contents");
    await mkdir(extractDir, { recursive: true });
    const remoteRoot = await extractAlfredMemoryBundle(bytes, extractDir);
    return await mergeAlfredMemoryFromDir({
      localRoot: opts.localRoot,
      remoteRoot,
      rebuildIndexes: opts.rebuildIndexes,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Read a zip from disk. */
export async function readZipFile(filePath: string): Promise<Buffer> {
  return readFile(path.resolve(filePath));
}
