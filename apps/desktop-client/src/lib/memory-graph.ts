import { readFile } from "node:fs/promises";
import {
  defaultOipMemoryRoot,
  dedupeMemoryGraph,
  FileVectorIndex,
  isPhotoFilename,
  OipLocalMemoryProvider,
  openaiApiKey,
  photoMimeFromFilename,
  rebuildOpenAiEmbeddings,
  buildSemanticMap,
  setSelfPerson,
  type DedupeProgressHandler,
  type EmbeddingRebuildProgress,
  type EmbeddingSpaceSnapshot,
  type MemoryRevision,
  type SemanticMapMethod,
  type SemanticMapResult,
  type TaggedHash,
  type VectorManifest,
} from "@alfred/memory";

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  schemaType: string | null;
  searchText: string;
  degree: number;
  updatedAt: string | null;
}

export interface GraphLink {
  source: string;
  target: string;
  predicate: string;
}

export interface MemoryGraphSnapshot {
  root: string;
  generatedAt: string;
  stats: {
    nodes: number;
    links: number;
    recordsIndexed: number;
    edgesIndexed: number;
    packagesOnDisk: number;
    rebuilt: boolean;
  };
  nodes: GraphNode[];
  links: GraphLink[];
}

function getProvider(profileId?: string): OipLocalMemoryProvider {
  const id = profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  return new OipLocalMemoryProvider(defaultOipMemoryRoot(id));
}

export type MemoryFileKind = "image" | "pdf" | "text" | "audio";

export interface MemoryFilePreview {
  artifactId: string;
  mimeType: string;
  filename: string;
  url: string;
  kind: MemoryFileKind;
}

/** @deprecated Use MemoryFilePreview */
export type MemoryImagePreview = MemoryFilePreview;

function asMemoryDid(id: string): string {
  return id.startsWith("did:memory:") ? id : `did:memory:${id}`;
}

function firstRef(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const hit = value.find((item) => typeof item === "string" && item.trim());
    return hit ? String(hit).trim() : null;
  }
  return null;
}

function revisionFilename(rev: MemoryRevision): string {
  return rev.originalFilename || rev.name || "";
}

function revisionMime(rev: MemoryRevision): string {
  const schema = (rev.schema ?? {}) as Record<string, unknown>;
  const fromSchema = typeof schema.encodingFormat === "string" ? schema.encodingFormat : "";
  const mime = (rev.mimeType || fromSchema).trim();
  if (mime) return mime;
  const filename = revisionFilename(rev);
  if (isPhotoFilename(filename)) return photoMimeFromFilename(filename);
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "rtf") return "application/rtf";
  if (ext === "txt" || ext === "text") return "text/plain";
  if (ext === "md" || ext === "markdown" || ext === "mdown" || ext === "mdx") return "text/markdown";
  if (ext === "json") return "application/json";
  if (ext === "m4a" || ext === "aac") return "audio/mp4";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "webm") return "audio/webm";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "flac") return "audio/flac";
  if (ext === "caf") return "audio/x-caf";
  return "";
}

function fileKindFromMime(mime: string, filename: string): MemoryFileKind | null {
  const lower = mime.toLowerCase();
  const name = filename.toLowerCase();
  if (lower.startsWith("image/") || isPhotoFilename(filename)) return "image";
  if (lower === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    lower.startsWith("audio/") ||
    /\.(m4a|mp3|wav|webm|aac|ogg|flac|caf)$/.test(name)
  ) {
    return "audio";
  }
  if (
    lower.startsWith("text/") ||
    lower === "application/rtf" ||
    lower === "application/json" ||
    /\.(md|markdown|mdown|mdx|txt|text|rtf|json)$/.test(name)
  ) {
    return "text";
  }
  return null;
}

function looksLikePreviewableFile(rev: MemoryRevision): boolean {
  return fileKindFromMime(revisionMime(rev), revisionFilename(rev)) != null;
}

function artifactPreviewUrl(artifactId: string): string {
  return `/memory/graph/artifact/${encodeURIComponent(artifactId)}`;
}

async function previewFromArtifactRevision(
  artifactId: string,
  rev: MemoryRevision,
): Promise<MemoryFilePreview | null> {
  if (rev.type !== "Artifact" || !rev.contentHash || !looksLikePreviewableFile(rev)) return null;
  const filename = revisionFilename(rev) || "file";
  const mimeType = revisionMime(rev) || "application/octet-stream";
  const kind = fileKindFromMime(mimeType, filename);
  if (!kind) return null;
  return {
    artifactId,
    mimeType,
    filename,
    url: artifactPreviewUrl(artifactId),
    kind,
  };
}

/** Resolve a stored original file (image, PDF, markdown, text, RTF) for a graph node. */
export async function resolveMemoryFilePreview(
  id: string,
  profileId?: string,
): Promise<MemoryFilePreview | null> {
  const provider = getProvider(profileId);
  provider.sqlite.open();
  const index = provider.sqlite.getRecord(id);
  if (!index) return null;
  const revision = await provider.packages.readCurrent(index.logical_id);
  if (!revision) return null;

  const self = await previewFromArtifactRevision(asMemoryDid(index.id), revision);
  if (self) return self;

  const linked =
    firstRef(revision.drefs?.sourceArtifact) ||
    firstRef(revision.sourceArtifact);
  if (!linked) return null;
  const artifactIndex = provider.sqlite.getRecord(linked) ?? provider.sqlite.getRecord(asMemoryDid(linked));
  if (!artifactIndex) return null;
  const artifactRev = await provider.packages.readCurrent(artifactIndex.logical_id);
  if (!artifactRev) return null;
  return previewFromArtifactRevision(asMemoryDid(artifactIndex.id), artifactRev);
}

/** Resolve a displayable image artifact for a graph node (self or sourceArtifact). */
export async function resolveMemoryImagePreview(
  id: string,
  profileId?: string,
): Promise<MemoryFilePreview | null> {
  const preview = await resolveMemoryFilePreview(id, profileId);
  return preview?.kind === "image" ? preview : null;
}

export async function readMemoryArtifactBytes(
  id: string,
  profileId?: string,
): Promise<{ bytes: Buffer; mimeType: string; filename: string } | null> {
  const preview = await resolveMemoryFilePreview(id, profileId);
  if (!preview) return null;
  const provider = getProvider(profileId);
  provider.sqlite.open();
  const index = provider.sqlite.getRecord(preview.artifactId);
  if (!index) return null;
  const revision = await provider.packages.readCurrent(index.logical_id);
  if (!revision?.contentHash) return null;
  const absolute = await provider.artifacts.findAbsolute(revision.contentHash as TaggedHash);
  if (!absolute) return null;
  return {
    bytes: await readFile(absolute),
    mimeType: preview.mimeType,
    filename: preview.filename,
  };
}

export async function loadMemoryGraph(opts?: {
  profileId?: string;
  /** Hide Artifact nodes (default true — they clutter the semantic graph). */
  hideArtifacts?: boolean;
  /** Hide raw conversation-turn Observations (default true). */
  hideConversationTurns?: boolean;
  /** Drop provenance/sourceArtifact edges (default true). */
  hideProvenanceEdges?: boolean;
  /** Force a full index rebuild from filesystem packages. */
  forceRebuild?: boolean;
}): Promise<MemoryGraphSnapshot> {
  const hideArtifacts = opts?.hideArtifacts !== false;
  const hideConversationTurns = opts?.hideConversationTurns !== false;
  const hideProvenance = opts?.hideProvenanceEdges !== false;
  const provider = getProvider(opts?.profileId);
  await provider.packages.ensureRoot();
  const sqlite = provider.sqlite;
  sqlite.open();

  const packageCount = (await provider.packages.listLogicalIds()).length;
  const indexedBefore = sqlite.countRecords();
  // Rebuild when forced, empty, or clearly out of sync with filesystem packages.
  let rebuilt = false;
  if (
    opts?.forceRebuild ||
    (packageCount > 0 && indexedBefore === 0) ||
    (packageCount > 0 && indexedBefore < Math.floor(packageCount * 0.5))
  ) {
    await provider.rebuildIndexes();
    rebuilt = true;
  }

  const records = sqlite.listAllRecords(Math.max(100_000, sqlite.countRecords()));
  const edges = sqlite.listAllEdges(Math.max(200_000, sqlite.countEdges()));

  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();

  for (const r of records) {
    if (hideArtifacts && r.record_type === "Artifact") continue;
    const label = (r.name ?? "").trim();
    // Hide soft-deleted / merged duplicates (legacy name prefix or index marker)
    if (
      /^\[superseded\]/i.test(label) ||
      /^superseded\s*[-–—:]/i.test(label) ||
      (r.search_text ?? "").includes("__alfred_superseded__")
    ) {
      continue;
    }
    if (
      hideConversationTurns &&
      (/^(user|assistant)\s+turn$/i.test(label) ||
        /\b(user|assistant)\s+turn\b/i.test(r.search_text ?? ""))
    ) {
      continue;
    }
    nodeIds.add(r.id);
    nodes.push({
      id: r.id,
      label: label || r.record_type,
      type: r.record_type,
      schemaType: r.schema_type,
      searchText: r.search_text ?? "",
      degree: 0,
      updatedAt: r.updated_at,
    });
  }

  const links: GraphLink[] = [];
  for (const e of edges) {
    if (hideProvenance && /provenance|sourceArtifact|source$/i.test(e.predicate)) continue;
    if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
    links.push({
      source: e.source_id,
      target: e.target_id,
      predicate: e.predicate,
    });
  }

  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;

  return {
    root: provider.rootDir,
    generatedAt: new Date().toISOString(),
    stats: {
      nodes: nodes.length,
      links: links.length,
      recordsIndexed: sqlite.countRecords(),
      edgesIndexed: sqlite.countEdges(),
      packagesOnDisk: packageCount,
      rebuilt,
    },
    nodes,
    links,
  };
}

export async function loadMemoryRecordDetail(
  id: string,
  profileId?: string,
): Promise<{
  index: ReturnType<OipLocalMemoryProvider["sqlite"]["getRecord"]>;
  revision: MemoryRevision | null;
  neighbors: Array<{ predicate: string; direction: "out" | "in"; id: string; label: string; type: string }>;
  file: MemoryFilePreview | null;
  image: MemoryFilePreview | null;
} | null> {
  const provider = getProvider(profileId);
  provider.sqlite.open();
  const index = provider.sqlite.getRecord(id);
  if (!index) return null;

  const logicalId = index.logical_id;
  const revision = await provider.packages.readCurrent(logicalId);
  const file = await resolveMemoryFilePreview(id, profileId);
  const image = file?.kind === "image" ? file : null;

  const out = provider.sqlite.edgesFrom(index.id);
  const inbound = provider.sqlite.edgesTo(index.id);
  const neighbors = [];

  for (const e of out) {
    const t = provider.sqlite.getRecord(e.target_id);
    neighbors.push({
      predicate: e.predicate,
      direction: "out" as const,
      id: e.target_id,
      label: t?.name ?? e.target_id,
      type: t?.record_type ?? "?",
    });
  }
  for (const e of inbound) {
    const s = provider.sqlite.getRecord(e.source_id);
    neighbors.push({
      predicate: e.predicate,
      direction: "in" as const,
      id: e.source_id,
      label: s?.name ?? e.source_id,
      type: s?.record_type ?? "?",
    });
  }

  return { index, revision, neighbors, file, image };
}

export async function updateMemoryRecord(
  id: string,
  patch: {
    name?: string;
    text?: string;
    summary?: string;
    email?: string | null;
    telephone?: string | null;
    birthDate?: string | null;
  },
  profileId?: string,
): Promise<{
  index: ReturnType<OipLocalMemoryProvider["sqlite"]["getRecord"]>;
  revision: MemoryRevision | null;
  neighbors: Array<{
    predicate: string;
    direction: "out" | "in";
    id: string;
    label: string;
    type: string;
  }>;
  file: MemoryFilePreview | null;
  image: MemoryFilePreview | null;
} | null> {
  const provider = getProvider(profileId);
  provider.sqlite.open();
  const index = provider.sqlite.getRecord(id);
  if (!index) return null;

  const logicalId = index.logical_id;
  const current = await provider.packages.readCurrent(logicalId);
  if (!current) return null;

  const nextName = patch.name != null ? patch.name.trim() : undefined;
  const nextBody =
    patch.text != null
      ? patch.text.trim()
      : patch.summary != null
        ? patch.summary.trim()
        : undefined;

  const schema = { ...(current.schema ?? {}) } as Record<string, unknown>;
  if (nextName != null) {
    schema.name = nextName;
  }
  if (nextBody != null) {
    if ("description" in schema || current.type === "Entity") {
      schema.description = nextBody;
    } else {
      schema.text = nextBody;
    }
  }
  if (patch.email !== undefined) {
    const email = patch.email?.trim() || "";
    if (email) schema.email = email;
    else delete schema.email;
  }
  if (patch.telephone !== undefined) {
    const telephone = patch.telephone?.trim() || "";
    if (telephone) schema.telephone = telephone;
    else delete schema.telephone;
  }
  if (patch.birthDate !== undefined) {
    const birthDate = patch.birthDate?.trim() || "";
    if (birthDate) schema.birthDate = birthDate;
    else delete schema.birthDate;
  }

  const contactBits = [
    typeof schema.description === "string" ? schema.description : null,
    typeof schema.email === "string" ? `email ${schema.email}` : null,
    typeof schema.telephone === "string" ? `phone ${schema.telephone}` : null,
    typeof schema.birthDate === "string" ? `birthday ${schema.birthDate}` : null,
  ].filter(Boolean);

  await provider.updateRecord(logicalId, {
    ...(nextName != null ? { name: nextName } : {}),
    ...(nextBody != null ||
    patch.email !== undefined ||
    patch.telephone !== undefined ||
    patch.birthDate !== undefined
      ? {
          text:
            nextBody != null
              ? nextBody
              : contactBits.length
                ? contactBits.join("; ")
                : current.text,
        }
      : {}),
    schema,
    updatedAt: new Date().toISOString(),
    provenance: {
      ...(current.provenance ?? {}),
      sourceType: current.provenance?.sourceType ?? "manual_edit",
      extractionMethod: "graph_editor",
      learnedAt: new Date().toISOString(),
    },
  });

  return loadMemoryRecordDetail(id, profileId);
}

export async function deleteMemoryRecord(
  id: string,
  profileId?: string,
): Promise<{ deleted: true; id: string } | null> {
  const provider = getProvider(profileId);
  provider.sqlite.open();
  const index = provider.sqlite.getRecord(id);
  if (!index) return null;

  await provider.delete(index.id);
  return { deleted: true, id: index.id };
}

/** Mark a Person entity as the profile self and migrate placeholder "User" edges. */
export async function setMemorySelf(
  id: string,
  profileId?: string,
): Promise<
  | {
      selfId: string;
      selfName: string;
      clearedPrevious: number;
      migratedAssertions: number;
      supersededPlaceholder: boolean;
      detail: NonNullable<Awaited<ReturnType<typeof loadMemoryRecordDetail>>>;
    }
  | null
> {
  const provider = getProvider(profileId);
  const result = await setSelfPerson(provider, id);
  const detail = await loadMemoryRecordDetail(result.selfId, profileId);
  if (!detail) return null;
  return { ...result, detail };
}

/** Merge duplicate Entity nodes and union their assertion connections. */
export async function cleanMemoryIndex(
  profileId?: string,
  onProgress?: DedupeProgressHandler,
) {
  const provider = getProvider(profileId);
  return dedupeMemoryGraph(provider, { includeDocuments: true, onProgress });
}

export type { EmbeddingSpaceSnapshot, EmbeddingRebuildProgress, VectorManifest };

/** Load cached embedding-space positions (PCA) for Graph (beta). */
export async function loadMemoryEmbeddings(opts?: {
  profileId?: string;
}): Promise<EmbeddingSpaceSnapshot> {
  const graph = await loadMemoryGraph({
    profileId: opts?.profileId,
    hideArtifacts: true,
    hideConversationTurns: true,
    hideProvenanceEdges: true,
  });
  const store = new FileVectorIndex(graph.root);
  const expected = new Set(graph.nodes.map((n) => n.id));
  return store.snapshot(expected);
}

/** Build OpenAI embeddings + PCA projection for current graph-visible records. */
export async function rebuildMemoryEmbeddings(
  profileId?: string,
  onProgress?: (p: EmbeddingRebuildProgress) => void | Promise<void>,
): Promise<{ manifest: VectorManifest; embedded: number }> {
  if (!openaiApiKey()) {
    throw new Error("OPENAI_API_KEY is required to build embedding space");
  }
  const graph = await loadMemoryGraph({
    profileId,
    hideArtifacts: true,
    hideConversationTurns: true,
    hideProvenanceEdges: true,
  });
  const provider = getProvider(profileId);
  provider.sqlite.open();
  const records = graph.nodes.map((n) => {
    const row = provider.sqlite.getRecord(n.id);
    return {
      id: n.id,
      revision: row?.current_revision ?? "",
      name: n.label,
      searchText: n.searchText,
    };
  });
  return rebuildOpenAiEmbeddings({
    rootDir: graph.root,
    records,
    onProgress,
  });
}

/**
 * Semantic Map for Graph (beta): project stored embeddings with MDS/PCA and
 * attach original-space k-NN. Categories (types) are for reveal/metrics only.
 */
export async function loadMemorySemanticMap(opts: {
  profileId?: string;
  nodeIds: string[];
  categories?: Array<string | null | undefined>;
  method?: SemanticMapMethod;
  dims?: 2 | 3;
  knnK?: number;
}): Promise<
  | { missing: true; stale?: boolean; manifest: VectorManifest | null }
  | {
      missing: false;
      stale: boolean;
      manifest: VectorManifest | null;
      map: SemanticMapResult;
    }
> {
  const graph = await loadMemoryGraph({
    profileId: opts.profileId,
    hideArtifacts: true,
    hideConversationTurns: true,
    hideProvenanceEdges: true,
  });
  const store = new FileVectorIndex(graph.root);
  const expected = new Set(graph.nodes.map((n) => n.id));
  const snap = await store.snapshot(expected);
  if (snap.missing) {
    return { missing: true, stale: snap.stale, manifest: snap.manifest };
  }

  const wanted = opts.nodeIds.length ? opts.nodeIds : [...expected];
  const pairs = await store.getEmbeddings(wanted);
  if (pairs.length < 2) {
    return { missing: true, stale: snap.stale, manifest: snap.manifest };
  }

  const catById = new Map<string, string | null | undefined>();
  for (let i = 0; i < wanted.length; i++) {
    catById.set(wanted[i]!, opts.categories?.[i] ?? null);
  }

  const map = buildSemanticMap({
    ids: pairs.map((p) => p.id),
    embeddings: pairs.map((p) => p.embedding),
    method: opts.method ?? "mds-cosine",
    dims: opts.dims ?? 2,
    knnK: opts.knnK ?? 3,
    categories: pairs.map((p) => catById.get(p.id) ?? null),
  });

  return {
    missing: false,
    stale: snap.stale,
    manifest: snap.manifest,
    map,
  };
}
