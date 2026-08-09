import {
  defaultOipMemoryRoot,
  OipLocalMemoryProvider,
  type MemoryRevision,
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

export async function loadMemoryGraph(opts?: {
  profileId?: string;
  /** Hide Artifact nodes (default true — they clutter the semantic graph). */
  hideArtifacts?: boolean;
  /** Drop provenance/sourceArtifact edges (default true). */
  hideProvenanceEdges?: boolean;
  /** Force a full index rebuild from filesystem packages. */
  forceRebuild?: boolean;
}): Promise<MemoryGraphSnapshot> {
  const hideArtifacts = opts?.hideArtifacts !== false;
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

  const records = sqlite.listAllRecords();
  const edges = sqlite.listAllEdges();

  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();

  for (const r of records) {
    if (hideArtifacts && r.record_type === "Artifact") continue;
    nodeIds.add(r.id);
    nodes.push({
      id: r.id,
      label: r.name?.trim() || r.record_type,
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
} | null> {
  const provider = getProvider(profileId);
  provider.sqlite.open();
  const index = provider.sqlite.getRecord(id);
  if (!index) return null;

  const logicalId = index.logical_id;
  const revision = await provider.packages.readCurrent(logicalId);

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

  return { index, revision, neighbors };
}
