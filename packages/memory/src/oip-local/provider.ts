import type {
  CanonicalMemoryRecord,
  MemoryProvider,
  MemoryProviderManifest,
  MemoryQuery,
  MemoryRetrievalResult,
  MemoryTurnCommit,
  NormalizedMemoryItem,
} from "@alfred/contracts";
import { ArtifactStore } from "./artifact-store.js";
import { resolveDref, type DrefLookup } from "./dref.js";
import type { TaggedHash } from "./hashing.js";
import { parseMemoryRef } from "./ids.js";
import { verifyStore, type IntegrityReport } from "./integrity.js";
import { GraphIndex } from "./indexes/graph-index.js";
import { SqliteMemoryIndex } from "./indexes/sqlite-index.js";
import { NoopVectorIndex, type VectorIndex } from "./indexes/vector-index.js";
import { PackageStore } from "./package-store.js";
import { defaultOipMemoryRoot } from "./paths.js";
import { retrieveMemories, toNormalized } from "./retrieval.js";
import { SCHEMA_ORG, schemaOrgPerson } from "./schema-org.js";
import type { MemoryRevision } from "./schemas.js";

export const OIP_LOCAL_MEMORY_PROVIDER_ID = "memory.oip-local";

export class OipLocalMemoryProvider implements MemoryProvider {
  readonly manifest: MemoryProviderManifest;
  readonly packages: PackageStore;
  readonly artifacts: ArtifactStore;
  readonly sqlite: SqliteMemoryIndex;
  readonly vectors: VectorIndex;

  private ready = false;

  constructor(
    readonly rootDir: string,
    id = OIP_LOCAL_MEMORY_PROVIDER_ID,
    vectors?: VectorIndex,
  ) {
    this.manifest = {
      id,
      displayName: "OIP Local Memory",
      version: "0.1.0",
      capabilities: [
        "retrieve",
        "commit_turn",
        "inspect",
        "edit",
        "delete",
        "import_canonical",
        "export_canonical",
        "file_backed",
        "episodic",
        "temporal_graph",
      ],
    };
    this.packages = new PackageStore(rootDir);
    this.artifacts = new ArtifactStore(rootDir);
    this.sqlite = new SqliteMemoryIndex(rootDir);
    this.vectors = vectors ?? new NoopVectorIndex();
  }

  get path(): string {
    return this.rootDir;
  }

  static forProfile(profileId: string): OipLocalMemoryProvider {
    return new OipLocalMemoryProvider(defaultOipMemoryRoot(profileId));
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await this.packages.ensureRoot();
    // Open sqlite (create empty schema); rebuild if no records but packages exist
    this.sqlite.open();
    const ids = await this.packages.listLogicalIds();
    if (ids.length) {
      const sample = this.sqlite.listByType("Entity", 1);
      const any = this.sqlite.listByType("Episode", 1);
      if (!sample.length && !any.length && !this.sqlite.listByType("Observation", 1).length) {
        await this.rebuildIndexes();
      }
    }
    this.ready = true;
  }

  drefLookup(): DrefLookup {
    return {
      getCurrent: (logicalId) => this.packages.readCurrent(logicalId),
      getRevision: (logicalId, revision) => this.packages.readRevision(logicalId, revision),
    };
  }

  async resolveRef(ref: string): Promise<MemoryRevision | null> {
    await this.ensureReady();
    return resolveDref(ref, this.drefLookup());
  }

  async verify(): Promise<IntegrityReport> {
    await this.ensureReady();
    return verifyStore(this.packages, this.artifacts);
  }

  async rebuildIndexes(): Promise<void> {
    await this.packages.ensureRoot();
    await this.sqlite.rebuild(this.packages, this.artifacts);
    this.ready = true;
  }

  async createRecord(
    type: MemoryRevision["type"],
    body: Parameters<PackageStore["createPackage"]>[0]["body"],
    logicalId?: string,
    opts?: { reindex?: boolean },
  ): Promise<MemoryRevision> {
    await this.ensureReady();
    const record = await this.packages.createPackage({ type, body, logicalId });
    if (opts?.reindex !== false) await this.rebuildIndexes();
    return record;
  }

  async updateRecord(
    didOrLogicalId: string,
    patch: Partial<MemoryRevision>,
    opts?: { reindex?: boolean },
  ): Promise<MemoryRevision> {
    await this.ensureReady();
    const record = await this.packages.appendRevision(didOrLogicalId, patch);
    if (opts?.reindex !== false) await this.rebuildIndexes();
    return record;
  }

  async retrieve(query: MemoryQuery): Promise<MemoryRetrievalResult> {
    await this.ensureReady();
    const items = await retrieveMemories(query, {
      packages: this.packages,
      sqlite: this.sqlite,
      providerId: this.manifest.id,
    });
    return {
      items,
      providerId: this.manifest.id,
      retrievedAt: new Date().toISOString(),
    };
  }

  async commitTurn(commit: MemoryTurnCommit): Promise<void> {
    await this.ensureReady();
    const now = new Date().toISOString();
    await this.packages.createPackage({
      type: "Observation",
      now,
      body: {
        text: commit.text,
        observedAt: now,
        schema: {
          "@type": "CreativeWork",
          text: commit.text,
          name: `${commit.role} turn`,
        },
        schemaType: "https://schema.org/CreativeWork",
        alfred: {
          visibility: "private",
          confidence: 1,
          assertionType: "explicit",
        },
        provenance: {
          sourceType: "conversation_turn",
          learnedAt: now,
          speaker: commit.role,
          extractionMethod: "commitTurn",
        },
        drefs: {
          session: commit.sessionId,
        },
      },
    });

    // Light heuristic: "my name is X" → Person entity
    const nameMatch = commit.text.match(/\bmy name is\s+([A-Z][a-zA-Z'-]+)/i);
    if (commit.role === "user" && nameMatch) {
      const name = nameMatch[1]!;
      await this.packages.createPackage({
        type: "Entity",
        now,
        body: {
          name,
          schemaType: SCHEMA_ORG.Person,
          schema: schemaOrgPerson(name),
          alfred: { entityClass: "Person", confidence: 0.9, visibility: "private" },
          learnedAt: now,
          provenance: { sourceType: "conversation_turn", learnedAt: now },
        },
      });
    }

    await this.rebuildIndexes();
  }

  async inspect(limit = 100): Promise<NormalizedMemoryItem[]> {
    await this.ensureReady();
    const items: NormalizedMemoryItem[] = [];
    for await (const rev of this.packages.iterateCurrentRevisions()) {
      items.push(toNormalized(rev, this.manifest.id, 1));
      if (items.length >= limit) break;
    }
    return items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async edit(id: string, content: string): Promise<void> {
    await this.ensureReady();
    const parsed = parseMemoryRef(id.startsWith("did:memory:") ? id : `did:memory:${id}`);
    const current = await this.packages.readCurrent(parsed.logicalId);
    if (!current) throw new Error(`Memory package not found: ${id}`);
    await this.packages.appendRevision(parsed.logicalId, {
      text: content,
      name: current.type === "Entity" ? content : current.name,
      schema: {
        ...(current.schema ?? {}),
        ...(current.type === "Entity" ? { name: content } : { text: content }),
      },
    });
    await this.rebuildIndexes();
  }

  async delete(id: string): Promise<void> {
    await this.ensureReady();
    const parsed = parseMemoryRef(id.startsWith("did:memory:") ? id : `did:memory:${id}`);
    await this.packages.deletePackage(parsed.logicalId);
    await this.rebuildIndexes();
  }

  async exportCanonical(): Promise<CanonicalMemoryRecord[]> {
    await this.ensureReady();
    const out: CanonicalMemoryRecord[] = [];
    for await (const rev of this.packages.iterateCurrentRevisions()) {
      out.push({
        id: rev.id,
        content: JSON.stringify(rev),
        createdAt: rev.createdAt,
        metadata: {
          kind: rev.type.toLowerCase(),
          type: rev.type,
          revision: rev.revision,
          providerId: this.manifest.id,
        },
      });
    }
    return out;
  }

  async importCanonical(records: CanonicalMemoryRecord[]): Promise<void> {
    await this.ensureReady();
    for (const r of records) {
      let rev: MemoryRevision | null = null;
      try {
        rev = JSON.parse(r.content) as MemoryRevision;
      } catch {
        continue;
      }
      if (!rev?.id || !rev.type) continue;
      const logicalId = rev.id.replace(/^did:memory:/, "").split("#")[0]!;
      const existing = await this.packages.readCurrent(logicalId);
      if (existing) {
        await this.packages.appendRevision(logicalId, rev);
      } else {
        const { id: _id, revision: _r, previousRevision: _p, type, createdAt, updatedAt, ...body } =
          rev;
        await this.packages.createPackage({
          type,
          logicalId,
          body: {
            ...body,
            createdAt: createdAt ?? r.createdAt,
            updatedAt: updatedAt ?? createdAt,
          },
        });
      }
    }
    await this.rebuildIndexes();
  }

  /** Convenience for graph traversal tests / CLI. */
  graph(): GraphIndex {
    this.sqlite.open();
    return new GraphIndex(this.sqlite);
  }

  async putArtifactBytes(
    bytes: Buffer,
    opts: {
      mimeType?: string;
      originalFilename?: string;
      name?: string;
      reindex?: boolean;
    } = {},
  ): Promise<MemoryRevision> {
    await this.ensureReady();
    const stored = await this.artifacts.putBytes(bytes, opts);
    return this.createRecord(
      "Artifact",
      {
        name: opts.name ?? opts.originalFilename ?? stored.contentHash,
        contentHash: stored.contentHash,
        mimeType: stored.mimeType,
        byteSize: stored.byteSize,
        originalFilename: stored.originalFilename,
        storedAt: stored.storedAt,
        ingestedAt: new Date().toISOString(),
        schemaType: "https://schema.org/MediaObject",
        schema: {
          "@type": "MediaObject",
          name: opts.name ?? opts.originalFilename,
          contentSize: String(stored.byteSize),
          encodingFormat: stored.mimeType,
        },
        alfred: { visibility: "private", confidence: 1 },
        provenance: { sourceType: "artifact_ingest", learnedAt: new Date().toISOString() },
      },
      undefined,
      { reindex: opts.reindex },
    );
  }
}


export function createOipLocalProvider(profileId = "profile.default"): OipLocalMemoryProvider {
  return OipLocalMemoryProvider.forProfile(profileId);
}

export type { TaggedHash };
