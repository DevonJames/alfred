import { readFile } from "node:fs/promises";
import { canonicalJsonBytes } from "./canonical-json.js";
import { hashBytes, type TaggedHash } from "./hashing.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { PackageStore } from "./package-store.js";
import type { MemoryRevision } from "./schemas.js";

export interface IntegrityIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface IntegrityReport {
  ok: boolean;
  issues: IntegrityIssue[];
  packagesChecked: number;
  revisionsChecked: number;
  artifactsChecked: number;
}

export async function verifyStore(
  packages: PackageStore,
  artifacts: ArtifactStore,
): Promise<IntegrityReport> {
  const issues: IntegrityIssue[] = [];
  let packagesChecked = 0;
  let revisionsChecked = 0;
  let artifactsChecked = 0;

  await packages.ensureRoot();
  const logicalIds = await packages.listLogicalIds();

  for (const logicalId of logicalIds) {
    packagesChecked += 1;
    const manifest = await packages.readManifest(logicalId);
    if (!manifest) {
      issues.push({
        severity: "error",
        code: "missing_manifest",
        message: `Missing manifest for ${logicalId}`,
        path: packages.manifestPath(logicalId),
      });
      continue;
    }

    const current = await packages.readRevision(
      logicalId,
      manifest.currentRevision as TaggedHash,
    );
    if (!current) {
      issues.push({
        severity: "error",
        code: "missing_current_revision",
        message: `Manifest currentRevision not found: ${manifest.currentRevision}`,
        path: packages.revisionPath(logicalId, manifest.currentRevision as TaggedHash),
      });
    }

    const revHashes = await packages.listRevisions(logicalId);
    for (const revHash of revHashes) {
      revisionsChecked += 1;
      const rev = await packages.readRevision(logicalId, revHash);
      if (!rev) {
        issues.push({
          severity: "error",
          code: "unreadable_revision",
          message: `Cannot read revision ${revHash}`,
          path: packages.revisionPath(logicalId, revHash),
        });
        continue;
      }

      const expected = computeRevisionHash(rev);
      if (expected !== rev.revision || expected !== revHash) {
        issues.push({
          severity: "error",
          code: "revision_hash_mismatch",
          message: `Revision tampered or mis-hashed: stored=${rev.revision} computed=${expected} file=${revHash}`,
          path: packages.revisionPath(logicalId, revHash),
        });
      }

      if (rev.previousRevision) {
        const prev = await packages.readRevision(logicalId, rev.previousRevision as TaggedHash);
        if (!prev) {
          issues.push({
            severity: "error",
            code: "broken_revision_chain",
            message: `previousRevision missing: ${rev.previousRevision}`,
            path: packages.revisionPath(logicalId, revHash),
          });
        }
      }

      if (rev.type === "Artifact" && rev.contentHash) {
        artifactsChecked += 1;
        const ok = await artifacts.verify(rev.contentHash as TaggedHash);
        if (!ok) {
          issues.push({
            severity: "error",
            code: "artifact_hash_mismatch",
            message: `Artifact bytes do not match ${rev.contentHash}`,
            path: rev.storedAt,
          });
        }
      }
    }
  }

  return {
    ok: issues.every((i) => i.severity !== "error"),
    issues,
    packagesChecked,
    revisionsChecked,
    artifactsChecked,
  };
}

/** Recompute content hash for a revision (revision field excluded via canonicalization). */
export function computeRevisionHash(record: MemoryRevision): TaggedHash {
  return hashBytes(canonicalJsonBytes(record));
}

export async function verifyRevisionFile(
  packages: PackageStore,
  logicalId: string,
  revision: TaggedHash,
): Promise<boolean> {
  const rev = await packages.readRevision(logicalId, revision);
  if (!rev) return false;
  return computeRevisionHash(rev) === revision && rev.revision === revision;
}

/** Low-level: verify raw JSON file bytes hash as claimed. */
export async function verifyRevisionPath(
  filePath: string,
  claimed: TaggedHash,
): Promise<boolean> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as MemoryRevision;
  return computeRevisionHash(raw) === claimed;
}
