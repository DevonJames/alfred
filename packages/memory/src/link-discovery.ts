/**
 * Manual pass: compact catalog of high-level memories → one LLM call → new
 * Assertion edges. Does not send Observation bodies or compare every pair.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashBytes } from "./oip-local/hashing.js";
import {
  defaultOipMemoryRoot,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  OipLocalMemoryProvider,
} from "./oip-local/index.js";
import { SCHEMA_ORG } from "./oip-local/schema-org.js";
import type { MemoryRevision } from "./oip-local/schemas.js";
import type { EdgeRow, RecordRow } from "./oip-local/indexes/sqlite-index.js";

export const LINK_PREDICATES = ["relatedTo", "about", "locatedAt", "sameTopic"] as const;
export type LinkPredicate = (typeof LINK_PREDICATES)[number];

export const MAX_LINKS_PER_RUN = 40;
export const MAX_GROUPS_PER_RUN = 8;
export const MAX_GROUP_MEMBERS = 12;
export const CATALOG_LIMIT = 400;

const GENERIC_HUB_NAMES = new Set([
  "me",
  "myself",
  "user",
  "people",
  "person",
  "memories",
  "memory",
  "things",
  "stuff",
  "miscellaneous",
  "misc",
  "other",
  "general",
  "life",
  "work",
  "notes",
  "files",
  "photos",
  "documents",
  "everything",
]);

export type LinkDiscoveryPhase = "catalog" | "llm" | "write" | "reindex" | "done";

export interface LinkDiscoveryProgress {
  phase: LinkDiscoveryPhase;
  label: string;
  current: number;
  total: number;
  percent: number;
}

export type LinkDiscoveryProgressHandler = (
  progress: LinkDiscoveryProgress,
) => void | Promise<void>;

export interface CatalogEntry {
  catalogId: string;
  id: string;
  logicalId: string;
  name: string;
  kind: string;
  summary: string;
  isCollection: boolean;
}

export interface LinkProposal {
  from: string;
  to: string;
  predicate: string;
  reason?: string;
}

export interface GroupProposal {
  name: string;
  summary?: string;
  members: string[];
  reason?: string;
}

export interface DiscoveryProposal {
  links: LinkProposal[];
  groups: GroupProposal[];
}

export type LinkDiscoveryProposer = (input: {
  catalog: CatalogEntry[];
  catalogText: string;
}) => Promise<DiscoveryProposal | LinkProposal[]>;

export interface DiscoveredLink {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  predicate: LinkPredicate;
  reason: string;
}

export interface LinkDiscoveryResult {
  catalogSize: number;
  proposals: number;
  created: number;
  skippedAlreadyLinked: number;
  skippedInvalid: number;
  hubsCreated: number;
  hubsReused: number;
  membersLinked: number;
  samples: Array<{ from: string; predicate: string; to: string; reason: string }>;
  groupSamples: Array<{ name: string; members: string[]; reused: boolean }>;
  catalogFingerprint: string;
}

export interface LinkDiscoveryLedger {
  lastRunAt: string;
  catalogFingerprint: string;
  created: number;
  catalogSize: number;
}

const STRUCTURAL_PREDICATES = new Set([
  "isPartOf",
  "relatedTo",
  "related",
  "subject",
  "object",
  "derivedFrom",
  "about",
  "locatedAt",
  "sameTopic",
]);

function asDid(id: string): string {
  return id.startsWith("did:memory:") ? id : `did:memory:${id}`;
}

function logicalOf(id: string): string {
  return id.replace(/^did:memory:/, "").split("#")[0]!;
}

function pairKey(a: string, b: string): string {
  const left = asDid(a);
  const right = asDid(b);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isSuperseded(row: RecordRow, rev: MemoryRevision | null): boolean {
  if ((row.name ?? "").startsWith("[superseded]")) return true;
  const meta = rev?.alfred as { supersededBy?: unknown } | undefined;
  return typeof meta?.supersededBy === "string" && Boolean(meta.supersededBy);
}

function schemaShort(schemaType: string | null | undefined, schema?: Record<string, unknown>): string {
  const raw = `${schemaType ?? ""} ${String(schema?.["@type"] ?? "")}`;
  const hit = raw.match(/Person|Place|Organization|Product|Event|Collection|DigitalDocument|ImageObject|Thing/i);
  return hit?.[0] ?? "Entity";
}

function isCollectionRev(rev: MemoryRevision | null, schemaType: string | null): boolean {
  const entityClass = String(rev?.alfred?.entityClass ?? "");
  if (/docs_folder|photo_album|collection|concept/i.test(entityClass)) return true;
  return /collection/i.test(`${schemaType ?? ""} ${String(rev?.schema?.["@type"] ?? "")}`);
}

function catalogKind(row: RecordRow, rev: MemoryRevision | null): string {
  const entityClass = String(rev?.alfred?.entityClass ?? "").trim();
  const typeName = schemaShort(row.schema_type, rev?.schema);
  if (row.record_type === "Episode") return entityClass ? `Episode/${entityClass}` : "Episode";
  if (entityClass) return `${typeName}/${entityClass}`;
  return typeName;
}

function catalogRank(entry: { kind: string; isCollection: boolean; recordType: string }): number {
  if (entry.isCollection) return 0;
  if (/person|place|organization/i.test(entry.kind)) return 1;
  if (/digitaldocument|imageobject|docs_file|uploaded_/i.test(entry.kind)) return 2;
  if (entry.recordType === "Episode") return 3;
  return 4;
}

function ledgerPath(rootDir: string): string {
  return path.join(rootDir, "indexes", "link-discovery.json");
}

export function formatCatalogText(catalog: CatalogEntry[]): string {
  return catalog
    .map((entry) => `${entry.catalogId} | ${entry.kind} | ${entry.name} | ${entry.summary}`)
    .join("\n");
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const slice = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    const parsed = JSON.parse(slice) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseLinkProposals(raw: string): LinkProposal[] {
  const parsed = parseJsonObject(raw);
  const links = parsed?.links;
  if (!Array.isArray(links)) return [];
  const out: LinkProposal[] = [];
  for (const item of links) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const from = typeof rec.from === "string" ? rec.from.trim() : "";
    const to = typeof rec.to === "string" ? rec.to.trim() : "";
    const predicate = typeof rec.predicate === "string" ? rec.predicate.trim() : "relatedTo";
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
    if (!from || !to) continue;
    out.push({ from, to, predicate, reason });
  }
  return out;
}

export function parseGroupProposals(raw: string): GroupProposal[] {
  const parsed = parseJsonObject(raw);
  const groups = parsed?.groups;
  if (!Array.isArray(groups)) return [];
  const out: GroupProposal[] = [];
  for (const item of groups) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const summary = typeof rec.summary === "string" ? rec.summary.trim() : "";
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
    const members = Array.isArray(rec.members)
      ? rec.members.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
      : [];
    if (!name || members.length < 2) continue;
    out.push({ name, summary, members, reason });
  }
  return out;
}

export function parseDiscoveryProposal(raw: string): DiscoveryProposal {
  return { links: parseLinkProposals(raw), groups: parseGroupProposals(raw) };
}

function asDiscoveryProposal(raw: DiscoveryProposal | LinkProposal[]): DiscoveryProposal {
  if (Array.isArray(raw)) return { links: raw, groups: [] };
  return {
    links: Array.isArray(raw.links) ? raw.links : [],
    groups: Array.isArray(raw.groups) ? raw.groups : [],
  };
}

export async function defaultLinkProposer(input: {
  catalog: CatalogEntry[];
  catalogText: string;
}): Promise<DiscoveryProposal> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("Find connections needs OPENAI_API_KEY");
  }
  const model = process.env.OPENAI_DOCS_EXTRACT_MODEL?.trim() || "gpt-5.6-terra";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You propose missing memory-graph links and concept grouping hubs as JSON. Never return prose outside JSON.",
        },
        { role: "user", content: linkDiscoveryPrompt(input.catalogText) },
      ],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (!res.ok) {
    throw new Error(body.error?.message || `Link discovery LLM failed (${res.status})`);
  }
  return parseDiscoveryProposal(body.choices?.[0]?.message?.content ?? "");
}

export function linkDiscoveryPrompt(catalogText: string): string {
  return `You are linking Alfred memories that were ingested at different times.

Each line is a high-level node:
catalogId | kind | name | summary

Catalog:
${catalogText}

1) Propose pairwise links that a human would want on the graph: same project, same person/place, same topic across different ingest sources (folders, photo albums, documents).

2) Also propose grouping hubs for shared concepts that currently sit only in names/summaries — not as their own catalog row. Examples: "AI", "USPTO", "Rock Hoppers", a product line, a company, a hobby. These become central nodes that pull currently disparate memories together. If a Collection/Organization already has that exact name, still propose the group so unattached members can join it.

Do NOT propose:
- parent/child (file in a folder, photo in an album, extract from a file)
- two names for the same thing if they are already obviously the same row
- self-links
- hubs named after a Person already in the catalog, or generic buckets ("me", "work", "life", "memories", "stuff")
- renaming an existing photo album or docs folder as the hub
- more than ${MAX_LINKS_PER_RUN} links
- more than ${MAX_GROUPS_PER_RUN} groups
- groups with fewer than 2 members

Predicates allowed: ${LINK_PREDICATES.join(", ")}

Return JSON only:
{
  "links":[{"from":"E1","to":"E2","predicate":"relatedTo","reason":"short why"}],
  "groups":[{"name":"USPTO","summary":"patent work","members":["E3","E9","E12"],"reason":"several memories about patents"}]
}`;
}

function normalizePredicate(value: string): LinkPredicate | null {
  const trimmed = value.trim();
  const hit = LINK_PREDICATES.find((p) => p.toLowerCase() === trimmed.toLowerCase());
  return hit ?? null;
}

function progress(
  onProgress: LinkDiscoveryProgressHandler | undefined,
  phase: LinkDiscoveryPhase,
  label: string,
  percent: number,
  current = 0,
  total = 0,
): Promise<void> {
  return Promise.resolve(onProgress?.({ phase, label, current, total, percent }));
}

function childNamesFor(
  id: string,
  inbound: EdgeRow[],
  byId: Map<string, RecordRow>,
): string {
  const names: string[] = [];
  for (const edge of inbound) {
    if (edge.predicate !== "isPartOf") continue;
    const child = byId.get(edge.source_id);
    const name = (child?.name ?? "").trim();
    if (!name || name.startsWith("[superseded]")) continue;
    if (names.includes(name)) continue;
    names.push(name);
    if (names.length >= 6) break;
  }
  return names.join(", ");
}

export async function buildLinkCatalog(
  provider: OipLocalMemoryProvider,
): Promise<{ catalog: CatalogEntry[]; fingerprint: string }> {
  provider.sqlite.open();
  const entities = provider.sqlite.listByType("Entity", 2000);
  const episodes = provider.sqlite.listByType("Episode", 400);
  const rows = [...entities, ...episodes];
  const byId = new Map(provider.sqlite.listAllRecords(8000).map((row) => [row.id, row]));
  const inboundByTarget = new Map<string, EdgeRow[]>();
  for (const edge of provider.sqlite.listAllEdges(30_000)) {
    const list = inboundByTarget.get(edge.target_id) ?? [];
    list.push(edge);
    inboundByTarget.set(edge.target_id, list);
  }

  type Ranked = CatalogEntry & { recordType: string; rank: number };
  const ranked: Ranked[] = [];
  for (const row of rows) {
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (isSuperseded(row, rev)) continue;
    const name = clip(row.name || rev?.name || row.logical_id, 80);
    if (!name) continue;
    const isCollection = isCollectionRev(rev, row.schema_type);
    const kind = catalogKind(row, rev);
    const kids = isCollection ? childNamesFor(row.id, inboundByTarget.get(row.id) ?? [], byId) : "";
    const text = clip(String(rev?.text || row.search_text || ""), 80);
    const summary = kids || (text && text !== name ? text : "");
    const entry: Ranked = {
      catalogId: "",
      id: asDid(row.id),
      logicalId: row.logical_id,
      name,
      kind,
      summary: clip(summary, 120),
      isCollection,
      recordType: row.record_type,
      rank: catalogRank({ kind, isCollection, recordType: row.record_type }),
    };
    ranked.push(entry);
  }

  ranked.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const catalog: CatalogEntry[] = ranked.slice(0, CATALOG_LIMIT).map((entry, index) => ({
    catalogId: `E${index + 1}`,
    id: entry.id,
    logicalId: entry.logicalId,
    name: entry.name,
    kind: entry.kind,
    summary: entry.summary,
    isCollection: entry.isCollection,
  }));
  const fingerprint = hashBytes(catalog.map((e) => `${e.id}\t${e.name}`).join("\n"));
  return { catalog, fingerprint };
}

function connectedPairs(edges: EdgeRow[]): Set<string> {
  const pairs = new Set<string>();
  const subjects = new Map<string, string>();
  const objects = new Map<string, string>();
  for (const edge of edges) {
    if (!edge.source_id || !edge.target_id) continue;
    if (asDid(edge.source_id) === asDid(edge.target_id)) continue;
    if (STRUCTURAL_PREDICATES.has(edge.predicate)) {
      pairs.add(pairKey(edge.source_id, edge.target_id));
    }
    if (edge.predicate === "subject") subjects.set(asDid(edge.source_id), asDid(edge.target_id));
    if (edge.predicate === "object") objects.set(asDid(edge.source_id), asDid(edge.target_id));
  }
  for (const [assertionId, subjectId] of subjects) {
    const objectId = objects.get(assertionId);
    if (objectId && objectId !== subjectId) pairs.add(pairKey(subjectId, objectId));
  }
  return pairs;
}

function collectionParents(
  edges: EdgeRow[],
  collectionIds: Set<string>,
): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.predicate !== "isPartOf") continue;
    const parent = asDid(edge.target_id);
    if (!collectionIds.has(parent)) continue;
    const child = asDid(edge.source_id);
    const set = parents.get(child) ?? new Set<string>();
    set.add(parent);
    parents.set(child, set);
  }
  return parents;
}

function shareCollectionParent(
  a: string,
  b: string,
  parents: Map<string, Set<string>>,
): boolean {
  const left = parents.get(asDid(a));
  const right = parents.get(asDid(b));
  if (!left || !right) return false;
  for (const id of left) {
    if (right.has(id)) return true;
  }
  return false;
}

export function filterLinkProposals(opts: {
  catalog: CatalogEntry[];
  proposals: LinkProposal[];
  edges: EdgeRow[];
}): {
  accepted: DiscoveredLink[];
  skippedAlreadyLinked: number;
  skippedInvalid: number;
} {
  const byCatalogId = new Map(opts.catalog.map((entry) => [entry.catalogId, entry]));
  const collectionIds = new Set(opts.catalog.filter((e) => e.isCollection).map((e) => e.id));
  const pairs = connectedPairs(opts.edges);
  const parents = collectionParents(opts.edges, collectionIds);
  const accepted: DiscoveredLink[] = [];
  const seen = new Set<string>();
  let skippedAlreadyLinked = 0;
  let skippedInvalid = 0;

  for (const proposal of opts.proposals) {
    const from = byCatalogId.get(proposal.from);
    const to = byCatalogId.get(proposal.to);
    const predicate = normalizePredicate(proposal.predicate) ?? (proposal.predicate ? null : "relatedTo");
    if (!from || !to || !predicate || from.id === to.id) {
      skippedInvalid += 1;
      continue;
    }
    const key = pairKey(from.id, to.id);
    if (seen.has(key)) {
      skippedInvalid += 1;
      continue;
    }
    if (pairs.has(key) || shareCollectionParent(from.id, to.id, parents)) {
      skippedAlreadyLinked += 1;
      continue;
    }
    seen.add(key);
    accepted.push({
      fromId: from.id,
      fromName: from.name,
      toId: to.id,
      toName: to.name,
      predicate,
      reason: clip(proposal.reason || `${from.name} ↔ ${to.name}`, 160),
    });
    if (accepted.length >= MAX_LINKS_PER_RUN) break;
  }

  return { accepted, skippedAlreadyLinked, skippedInvalid };
}

function normHubName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function canReuseAsHub(entry: CatalogEntry): boolean {
  if (/photo_album|docs_folder|docs_file|uploaded_/i.test(entry.kind)) return false;
  if (/person/i.test(entry.kind)) return false;
  if (entry.isCollection) return true;
  return /organization|thing|concept|product/i.test(entry.kind);
}

export interface AcceptedGroup {
  name: string;
  summary: string;
  reason: string;
  members: CatalogEntry[];
  reuse: CatalogEntry | null;
}

export function filterGroupProposals(opts: {
  catalog: CatalogEntry[];
  groups: GroupProposal[];
  edges: EdgeRow[];
}): { accepted: AcceptedGroup[]; skippedInvalid: number } {
  const byCatalogId = new Map(opts.catalog.map((entry) => [entry.catalogId, entry]));
  const byName = new Map(
    opts.catalog.filter((e) => canReuseAsHub(e)).map((e) => [normHubName(e.name), e]),
  );
  const personNames = new Set(
    opts.catalog.filter((e) => /person/i.test(e.kind)).map((e) => normHubName(e.name)),
  );
  const collectionIds = new Set(opts.catalog.filter((e) => e.isCollection).map((e) => e.id));
  const parents = collectionParents(opts.edges, collectionIds);
  const pairs = connectedPairs(opts.edges);
  const accepted: AcceptedGroup[] = [];
  const seenNames = new Set<string>();
  let skippedInvalid = 0;

  for (const group of opts.groups) {
    const name = clip(group.name, 48);
    const key = normHubName(name);
    if (
      !name ||
      key.length < 2 ||
      GENERIC_HUB_NAMES.has(key) ||
      personNames.has(key) ||
      seenNames.has(key)
    ) {
      skippedInvalid += 1;
      continue;
    }
    const members: CatalogEntry[] = [];
    const seenMembers = new Set<string>();
    for (const id of group.members) {
      const entry = byCatalogId.get(id);
      if (!entry || seenMembers.has(entry.id)) continue;
      seenMembers.add(entry.id);
      members.push(entry);
      if (members.length >= MAX_GROUP_MEMBERS) break;
    }
    const reuse = byName.get(key) ?? null;
    const attachable = members.filter((m) => {
      if (reuse && m.id === reuse.id) return false;
      if (reuse && (pairs.has(pairKey(m.id, reuse.id)) || shareCollectionParent(m.id, reuse.id, parents))) {
        return false;
      }
      return true;
    });
    if (attachable.length < 2) {
      skippedInvalid += 1;
      continue;
    }
    seenNames.add(key);
    accepted.push({
      name,
      summary: clip(group.summary || group.reason || name, 160),
      reason: clip(group.reason || `groups ${attachable.length} related memories`, 160),
      members: attachable,
      reuse,
    });
    if (accepted.length >= MAX_GROUPS_PER_RUN) break;
  }

  return { accepted, skippedInvalid };
}

async function upsertConceptEntity(
  provider: OipLocalMemoryProvider,
  name: string,
  summary: string,
  learnedAt: string,
): Promise<{ hub: MemoryRevision; created: boolean }> {
  const named = provider.sqlite.findByName(name, "Entity");
  const hit = named.find((r) => {
    if (normHubName(r.name ?? "") !== normHubName(name)) return false;
    const blob = `${r.schema_type ?? ""} ${r.search_text ?? ""}`;
    if (/photo_album|docs_folder|docs_file|uploaded_/i.test(blob)) return false;
    return /concept|collection|organization/i.test(blob);
  });
  if (hit) {
    const current = await provider.packages.readCurrent(hit.logical_id);
    if (current) return { hub: current, created: false };
  }
  const hub = await provider.createRecord(
    "Entity",
    {
      name,
      text: summary,
      schemaType: SCHEMA_ORG.Collection,
      schema: { "@type": "Collection", name, description: summary },
      alfred: { entityClass: "concept", visibility: "private" as const, confidence: 0.75 },
      learnedAt,
      provenance: {
        sourceType: "link_discovery",
        extractionMethod: "concept_hub",
        folderLabel: name,
        learnedAt,
      },
    },
    undefined,
    { reindex: false },
  );
  return { hub, created: true };
}

async function attachIsPartOf(
  provider: OipLocalMemoryProvider,
  memberId: string,
  hubId: string,
): Promise<boolean> {
  const rec = await provider.packages.readCurrent(logicalOf(memberId));
  if (!rec) return false;
  const hub = asDid(hubId);
  const current = rec.drefs?.isPartOf;
  const list = Array.isArray(current) ? current.map(String) : current ? [String(current)] : [];
  if (list.some((id) => asDid(id) === hub)) return false;
  list.push(hub);
  await provider.updateRecord(
    memberId,
    { drefs: { isPartOf: list.length === 1 ? list[0] : list } },
    { reindex: false },
  );
  return true;
}

async function writeLedger(rootDir: string, ledger: LinkDiscoveryLedger): Promise<void> {
  const file = ledgerPath(rootDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export async function readLinkDiscoveryLedger(rootDir: string): Promise<LinkDiscoveryLedger | null> {
  try {
    const raw = await readFile(ledgerPath(rootDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<LinkDiscoveryLedger>;
    if (!parsed.lastRunAt || !parsed.catalogFingerprint) return null;
    return {
      lastRunAt: parsed.lastRunAt,
      catalogFingerprint: parsed.catalogFingerprint,
      created: Number(parsed.created) || 0,
      catalogSize: Number(parsed.catalogSize) || 0,
    };
  } catch {
    return null;
  }
}

export async function discoverMemoryLinks(opts?: {
  profileId?: string;
  providerId?: string;
  provider?: OipLocalMemoryProvider;
  propose?: LinkDiscoveryProposer;
  onProgress?: LinkDiscoveryProgressHandler;
}): Promise<LinkDiscoveryResult> {
  const profileId = opts?.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const providerId =
    opts?.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID;
  if (
    !opts?.provider &&
    providerId !== OIP_LOCAL_MEMORY_PROVIDER_ID &&
    providerId !== "memory.oip-local"
  ) {
    throw new Error("Link discovery requires the local OIP memory provider");
  }

  const root = opts?.provider?.rootDir ?? defaultOipMemoryRoot(profileId);
  const provider = opts?.provider ?? new OipLocalMemoryProvider(root);
  await provider.packages.ensureRoot();
  provider.sqlite.open();

  await progress(opts?.onProgress, "catalog", "Building memory catalog…", 8);
  const { catalog, fingerprint } = await buildLinkCatalog(provider);
  await progress(
    opts?.onProgress,
    "catalog",
    `Catalogued ${catalog.length} high-level memories`,
    18,
    catalog.length,
    catalog.length,
  );

  if (catalog.length < 2) {
    const empty: LinkDiscoveryResult = {
      catalogSize: catalog.length,
      proposals: 0,
      created: 0,
      skippedAlreadyLinked: 0,
      skippedInvalid: 0,
      hubsCreated: 0,
      hubsReused: 0,
      membersLinked: 0,
      samples: [],
      groupSamples: [],
      catalogFingerprint: fingerprint,
    };
    await writeLedger(provider.rootDir, {
      lastRunAt: new Date().toISOString(),
      catalogFingerprint: fingerprint,
      created: 0,
      catalogSize: catalog.length,
    });
    await progress(opts?.onProgress, "done", "Not enough memories to link", 100);
    return empty;
  }

  await progress(opts?.onProgress, "llm", "Asking the model for missing links and concept hubs…", 30);
  const proposer = opts?.propose ?? defaultLinkProposer;
  const proposed = asDiscoveryProposal(
    await proposer({ catalog, catalogText: formatCatalogText(catalog) }),
  );
  await progress(
    opts?.onProgress,
    "llm",
    `Model proposed ${proposed.links.length} link${proposed.links.length === 1 ? "" : "s"} and ${proposed.groups.length} group${proposed.groups.length === 1 ? "" : "s"}`,
    55,
    proposed.links.length + proposed.groups.length,
    proposed.links.length + proposed.groups.length,
  );

  const edges = provider.sqlite.listAllEdges(30_000);
  const filtered = filterLinkProposals({
    catalog,
    proposals: proposed.links,
    edges,
  });
  const groups = filterGroupProposals({
    catalog,
    groups: proposed.groups,
    edges,
  });

  const learnedAt = new Date().toISOString();
  let created = 0;
  let hubsCreated = 0;
  let hubsReused = 0;
  let membersLinked = 0;
  const writeTotal = filtered.accepted.length + groups.accepted.length;
  await progress(
    opts?.onProgress,
    "write",
    `Writing ${filtered.accepted.length} link${filtered.accepted.length === 1 ? "" : "s"} and ${groups.accepted.length} hub${groups.accepted.length === 1 ? "" : "s"}…`,
    65,
    0,
    writeTotal,
  );
  for (const link of filtered.accepted) {
    await provider.createRecord(
      "Assertion",
      {
        name: link.predicate,
        text: link.reason,
        predicate: link.predicate,
        subject: link.fromId,
        object: link.toId,
        schemaType: SCHEMA_ORG.Thing,
        schema: { "@type": "Statement", name: link.predicate },
        alfred: {
          visibility: "private" as const,
          confidence: 0.7,
          assertionType: "inferred" as const,
        },
        learnedAt,
        provenance: {
          sourceType: "link_discovery",
          extractionMethod: "link_discovery",
          learnedAt,
        },
        drefs: {
          subject: link.fromId,
          object: link.toId,
        },
      },
      undefined,
      { reindex: false },
    );
    created += 1;
    if (created === filtered.accepted.length || created % 5 === 0) {
      await progress(
        opts?.onProgress,
        "write",
        `Wrote ${created} of ${filtered.accepted.length}`,
        65 + Math.round((created / Math.max(1, writeTotal)) * 12),
        created,
        writeTotal,
      );
    }
  }

  const groupSamples: LinkDiscoveryResult["groupSamples"] = [];
  for (const group of groups.accepted) {
    let hub = group.reuse
      ? await provider.packages.readCurrent(group.reuse.logicalId)
      : null;
    let reused = Boolean(hub);
    if (!hub) {
      const upserted = await upsertConceptEntity(provider, group.name, group.summary, learnedAt);
      hub = upserted.hub;
      reused = !upserted.created;
    }
    if (reused) hubsReused += 1;
    else hubsCreated += 1;
    let attached = 0;
    for (const member of group.members) {
      if (await attachIsPartOf(provider, member.id, hub.id)) attached += 1;
    }
    membersLinked += attached;
    groupSamples.push({
      name: group.name,
      members: group.members.map((m) => m.name),
      reused,
    });
  }

  await progress(opts?.onProgress, "reindex", "Rebuilding graph index…", 92);
  await provider.rebuildIndexes();

  const result: LinkDiscoveryResult = {
    catalogSize: catalog.length,
    proposals: proposed.links.length + proposed.groups.length,
    created,
    skippedAlreadyLinked: filtered.skippedAlreadyLinked,
    skippedInvalid: filtered.skippedInvalid + groups.skippedInvalid,
    hubsCreated,
    hubsReused,
    membersLinked,
    samples: filtered.accepted.slice(0, 8).map((link) => ({
      from: link.fromName,
      predicate: link.predicate,
      to: link.toName,
      reason: link.reason,
    })),
    groupSamples: groupSamples.slice(0, 8),
    catalogFingerprint: fingerprint,
  };
  await writeLedger(provider.rootDir, {
    lastRunAt: learnedAt,
    catalogFingerprint: fingerprint,
    created: created + hubsCreated,
    catalogSize: catalog.length,
  });
  const doneLabel = [
    created ? `${created} link${created === 1 ? "" : "s"}` : "",
    hubsCreated ? `${hubsCreated} hub${hubsCreated === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  await progress(
    opts?.onProgress,
    "done",
    doneLabel ? `Created ${doneLabel}` : "No new connections",
    100,
    created + hubsCreated,
    writeTotal,
  );
  return result;
}
