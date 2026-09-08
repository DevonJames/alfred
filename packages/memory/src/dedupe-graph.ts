/**
 * Deduplicate Entity packages with the same display name + type class.
 * Retargets assertion subject/object links onto the survivor so the union of
 * connections is preserved (A→X,Y merged with A'→X keeps X and Y).
 *
 * Superseded losers keep a clean display name and are marked via
 * `alfred.supersededBy` (not a `[superseded]` name prefix). Clean Index also
 * scrubs legacy prefixes from existing packages.
 */

import type { OipLocalMemoryProvider } from "./oip-local/provider.js";
import type { MemoryRevision } from "./oip-local/schemas.js";

/** Marker embedded in FTS search_text so the graph UI can hide superseded rows. */
export const SUPERSEDED_SEARCH_MARKER = "__alfred_superseded__";

function asDid(id: string): string {
  return id.startsWith("did:memory:") ? id : `did:memory:${id}`;
}

function logicalOf(id: string): string {
  return id.replace(/^did:memory:/, "").split("#")[0]!;
}

/**
 * Strip legacy Clean Index / self-identity prefixes:
 * `[superseded] Original → Winner` → `Original`
 * `[superseded] Original` → `Original`
 */
export function restoreDisplayName(raw: string | null | undefined): string {
  let name = String(raw ?? "").trim();
  if (!name) return "";
  for (let i = 0; i < 6; i++) {
    const next = name
      .replace(/^\[superseded\]\s*/i, "")
      .replace(/^superseded\s*[-–—:]\s*/i, "")
      .trim();
    const arrow = next.match(/^(.*?)(?:\s*→\s*.+)$/);
    const candidate = (arrow ? arrow[1]! : next).trim();
    if (!candidate || candidate === name) {
      name = candidate || next;
      break;
    }
    name = candidate;
  }
  return name;
}

export function revisionIsSuperseded(rev: MemoryRevision | null | undefined): boolean {
  const meta = rev?.alfred as { supersededBy?: unknown } | undefined;
  return typeof meta?.supersededBy === "string" && Boolean(meta.supersededBy);
}

export function recordLooksSuperseded(
  name: string | null | undefined,
  searchText?: string | null,
): boolean {
  const n = String(name ?? "");
  if (/^\[superseded\]/i.test(n) || /^superseded\s*[-–—:]/i.test(n)) return true;
  if (searchText && searchText.includes(SUPERSEDED_SEARCH_MARKER)) return true;
  return false;
}

function entityClassKey(schemaType: string | null | undefined, schema?: Record<string, unknown>): string {
  const st = `${schemaType ?? ""} ${String(schema?.["@type"] ?? "")}`.toLowerCase();
  if (st.includes("person")) return "Person";
  if (st.includes("organization")) return "Organization";
  if (st.includes("place")) return "Place";
  if (st.includes("product")) return "Product";
  if (st.includes("event")) return "Event";
  if (st.includes("collection")) return "Collection";
  if (st.includes("digitaldocument") || st.includes("article") || st.includes("socialmediaposting")) {
    return "Document";
  }
  if (st.includes("creativework") || st.includes("thing") || st.includes("project")) return "Thing";
  return "Other";
}

export interface DedupeGraphResult {
  groupsMerged: number;
  entitiesSuperseded: number;
  assertionsRetargeted: number;
  assertionsSuperseded: number;
  namesScrubbed: number;
  samples: Array<{ name: string; kept: string; removed: string[] }>;
}

export type DedupePhase = "scrub" | "scan" | "merge" | "collapse" | "reindex" | "done";

export interface DedupeProgress {
  phase: DedupePhase;
  label: string;
  current: number;
  total: number;
  percent: number;
}

export type DedupeProgressHandler = (progress: DedupeProgress) => void | Promise<void>;

function lerpPercent(start: number, end: number, current: number, total: number): number {
  if (total <= 0) return end;
  const t = Math.min(1, Math.max(0, current / total));
  return Math.round(start + (end - start) * t);
}

type EntityRow = {
  id: string;
  logicalId: string;
  name: string;
  schemaType: string | null;
  rev: MemoryRevision;
  degree: number;
};

function scoreEntity(row: EntityRow): number {
  const alfred = (row.rev.alfred ?? {}) as Record<string, unknown>;
  const schema = (row.rev.schema ?? {}) as Record<string, unknown>;
  let score = row.degree * 10;
  if (alfred.isSelf === true) score += 10_000;
  const desc = String(schema.description ?? row.rev.text ?? "");
  if (/primary user/i.test(desc)) score += 500;
  if (typeof schema.email === "string" && schema.email) score += 20;
  if (typeof schema.telephone === "string" && schema.telephone) score += 20;
  if (typeof schema.birthDate === "string" && schema.birthDate) score += 20;
  if (desc.length > 40) score += Math.min(40, Math.floor(desc.length / 20));
  // Prefer older canonical knowledge-ingest ids when degree ties (ULID earlier = smaller)
  score += Math.max(0, 50 - Math.min(50, row.logicalId.length));
  return score;
}

function mergeSchema(
  keep: Record<string, unknown>,
  from: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...keep };
  for (const key of Object.keys(from)) {
    if (key === "@type" || key === "name") continue;
    const cur = out[key];
    const next = from[key];
    if (cur == null || cur === "") {
      out[key] = next;
      continue;
    }
    if (
      typeof cur === "string" &&
      typeof next === "string" &&
      next.trim() &&
      !cur.toLowerCase().includes(next.trim().toLowerCase()) &&
      (key === "description" || key === "text")
    ) {
      out[key] = `${cur}\n\n${next}`.trim();
    }
  }
  return out;
}

/**
 * Merge duplicate Entity nodes (same name + type class). Survivor keeps the
 * union of assertion connections from every duplicate.
 */
export async function dedupeMemoryGraph(
  provider: OipLocalMemoryProvider,
  opts?: { includeDocuments?: boolean; onProgress?: DedupeProgressHandler },
): Promise<DedupeGraphResult> {
  await provider.packages.ensureRoot();
  provider.sqlite.open();

  const includeDocuments = opts?.includeDocuments !== false;
  const onProgress = opts?.onProgress;
  const now = new Date().toISOString();

  const report = async (
    phase: DedupePhase,
    label: string,
    current: number,
    total: number,
    percent: number,
  ) => {
    await onProgress?.({ phase, label, current, total, percent });
  };

  await report("scrub", "Removing [superseded] name prefixes…", 0, 1, 0);
  const namesScrubbed = await scrubSupersededNamePrefixes(provider, now, onProgress);

  const entityHits = provider.sqlite.listByType("Entity", 20_000);
  await report("scan", "Reading entities…", 0, entityHits.length, 8);

  const rows: EntityRow[] = [];
  let scanned = 0;
  for (const row of entityHits) {
    scanned += 1;
    const name = restoreDisplayName(row.name).trim();
    if (name) {
      const rev = await provider.packages.readCurrent(row.logical_id);
      if (rev && !revisionIsSuperseded(rev)) {
        const classKey = entityClassKey(row.schema_type, rev.schema as Record<string, unknown>);
        if (includeDocuments || classKey !== "Document") {
          const id = asDid(row.id);
          const degree =
            provider.sqlite.edgesFrom(id).length + provider.sqlite.edgesTo(id).length;
          rows.push({
            id,
            logicalId: row.logical_id,
            name,
            schemaType: row.schema_type,
            rev,
            degree,
          });
        }
      }
    }
    if (scanned === entityHits.length || scanned % 25 === 0) {
      await report(
        "scan",
        "Reading entities…",
        scanned,
        entityHits.length,
        lerpPercent(8, 30, scanned, entityHits.length),
      );
    }
  }

  const groups = new Map<string, EntityRow[]>();
  for (const row of rows) {
    const classKey = entityClassKey(row.schemaType, row.rev.schema as Record<string, unknown>);
    const key = `${classKey}|${row.name.toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let groupsMerged = 0;
  let entitiesSuperseded = 0;
  let assertionsRetargeted = 0;
  let assertionsSuperseded = 0;
  const samples: DedupeGraphResult["samples"] = [];
  const mergeGroups = [...groups.values()].filter((group) => group.length >= 2);
  await report(
    "merge",
    mergeGroups.length ? `Merging ${mergeGroups.length} duplicate group(s)…` : "No duplicate groups",
    0,
    mergeGroups.length,
    32,
  );

  for (const group of mergeGroups) {
    const ranked = [...group].sort((a, b) => scoreEntity(b) - scoreEntity(a));
    const winner = ranked[0]!;
    const losers = ranked.slice(1);
    groupsMerged += 1;

    let winnerSchema = { ...((winner.rev.schema ?? {}) as Record<string, unknown>) };
    let winnerAlfred = { ...((winner.rev.alfred ?? {}) as Record<string, unknown>) };
    let winnerText = winner.rev.text;
    let schemaDirty = false;

    for (const loser of losers) {
      const merged = mergeSchema(
        winnerSchema,
        (loser.rev.schema ?? {}) as Record<string, unknown>,
      );
      if (JSON.stringify(merged) !== JSON.stringify(winnerSchema)) {
        winnerSchema = merged;
        schemaDirty = true;
      }
      if (loser.rev.alfred && (loser.rev.alfred as { isSelf?: boolean }).isSelf) {
        winnerAlfred = { ...winnerAlfred, isSelf: true };
        schemaDirty = true;
      }
      if (
        typeof loser.rev.text === "string" &&
        loser.rev.text.trim() &&
        (!winnerText || !String(winnerText).includes(loser.rev.text.trim()))
      ) {
        winnerText = winnerText
          ? `${winnerText}\n\n${loser.rev.text}`.trim()
          : loser.rev.text;
        schemaDirty = true;
      }
    }

    if (schemaDirty) {
      await provider.updateRecord(
        winner.logicalId,
        {
          schema: winnerSchema,
          alfred: winnerAlfred,
          ...(winnerText != null ? { text: winnerText } : {}),
          updatedAt: now,
          provenance: {
            ...(winner.rev.provenance ?? {}),
            sourceType: "graph_dedupe",
            extractionMethod: "clean_index",
            learnedAt: now,
          },
        },
        { reindex: false },
      );
    }

    const removedNames: string[] = [];
    for (const loser of losers) {
      removedNames.push(loser.id);
      const retargeted = await retargetAssertions(
        provider,
        loser.id,
        winner.id,
        winner.name,
        now,
      );
      assertionsRetargeted += retargeted.retargeted;
      assertionsSuperseded += retargeted.superseded;

      await provider.updateRecord(
        loser.logicalId,
        {
          // Keep a readable name; hide via alfred.supersededBy + search marker
          name: restoreDisplayName(loser.name),
          schema: {
            ...((loser.rev.schema ?? {}) as Record<string, unknown>),
            name: restoreDisplayName(loser.name),
            description: `Superseded duplicate of ${winner.name} (${winner.id}).`,
          },
          alfred: {
            ...((loser.rev.alfred ?? {}) as Record<string, unknown>),
            isSelf: false,
            supersededBy: winner.id,
          },
          updatedAt: now,
          provenance: {
            ...(loser.rev.provenance ?? {}),
            sourceType: "graph_dedupe",
            extractionMethod: "clean_index",
            learnedAt: now,
          },
        },
        { reindex: false },
      );
      entitiesSuperseded += 1;
    }

    if (samples.length < 40) {
      samples.push({
        name: winner.name,
        kept: winner.id,
        removed: removedNames,
      });
    }

    await report(
      "merge",
      `Merging ${winner.name}…`,
      groupsMerged,
      mergeGroups.length,
      lerpPercent(32, 78, groupsMerged, mergeGroups.length),
    );
  }

  await report("collapse", "Collapsing duplicate assertions…", 0, 1, 80);
  const collapsed = await collapseDuplicateAssertions(provider, now, onProgress);
  assertionsSuperseded += collapsed;

  await report("reindex", "Rebuilding search index…", 0, 1, 90);
  await provider.rebuildIndexes();
  await report("done", "Clean complete", 1, 1, 100);

  return {
    groupsMerged,
    entitiesSuperseded,
    assertionsRetargeted,
    assertionsSuperseded,
    namesScrubbed,
    samples,
  };
}

async function scrubSupersededNamePrefixes(
  provider: OipLocalMemoryProvider,
  now: string,
  onProgress?: DedupeProgressHandler,
): Promise<number> {
  const all = provider.sqlite.listAllRecords();
  let scrubbed = 0;
  let i = 0;
  for (const row of all) {
    i += 1;
    const raw = (row.name ?? "").trim();
    const cleaned = restoreDisplayName(raw);
    const needsNameFix = Boolean(cleaned) && cleaned !== raw;
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev) continue;
    const schemaName =
      typeof rev.schema?.name === "string" ? String(rev.schema.name).trim() : "";
    const cleanedSchema = schemaName ? restoreDisplayName(schemaName) : cleaned;
    const needsSchemaFix = Boolean(schemaName) && cleanedSchema !== schemaName;
    if (!needsNameFix && !needsSchemaFix) {
      if (onProgress && (i === all.length || i % 40 === 0)) {
        await onProgress({
          phase: "scrub",
          label: "Removing [superseded] name prefixes…",
          current: i,
          total: all.length,
          percent: lerpPercent(0, 8, i, all.length),
        });
      }
      continue;
    }
    const nextName = cleaned || restoreDisplayName(rev.name) || cleanedSchema;
    await provider.updateRecord(
      row.logical_id,
      {
        name: nextName,
        schema: {
          ...(rev.schema ?? {}),
          name: cleanedSchema || nextName,
        },
        alfred: {
          ...((rev.alfred ?? {}) as Record<string, unknown>),
        },
        updatedAt: now,
      },
      { reindex: false },
    );
    scrubbed += 1;
    if (onProgress && (i === all.length || i % 40 === 0)) {
      await onProgress({
        phase: "scrub",
        label: "Removing [superseded] name prefixes…",
        current: i,
        total: all.length,
        percent: lerpPercent(0, 8, i, all.length),
      });
    }
  }
  return scrubbed;
}

async function retargetAssertions(
  provider: OipLocalMemoryProvider,
  fromDid: string,
  toDid: string,
  toName: string,
  now: string,
): Promise<{ retargeted: number; superseded: number }> {
  let retargeted = 0;
  let superseded = 0;

  for (const row of provider.sqlite.listByType("Assertion", 20_000)) {
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev) continue;
    if (revisionIsSuperseded(rev) || recordLooksSuperseded(row.name)) continue;

    const subject = rev.subject != null ? asDid(String(rev.subject)) : null;
    const object = rev.object != null ? asDid(String(rev.object)) : null;
    if (subject !== fromDid && object !== fromDid) continue;

    const nextSubject = subject === fromDid ? toDid : subject;
    const nextObject = object === fromDid ? toDid : object;
    const predicate = String(rev.predicate ?? "relatedTo");

    if (nextSubject && nextObject) {
      const dup = await findAssertion(
        provider,
        nextSubject,
        predicate,
        nextObject,
        row.logical_id,
      );
      if (dup) {
        await provider.updateRecord(
          row.logical_id,
          {
            name: restoreDisplayName(row.name) || "assertion",
            alfred: {
              ...((rev.alfred ?? {}) as Record<string, unknown>),
              supersededBy: dup,
            },
            updatedAt: now,
          },
          { reindex: false },
        );
        superseded += 1;
        continue;
      }
    }

    const assertionName =
      subject === fromDid
        ? `${toName} ${predicate}`
        : (row.name ?? `${predicate}`);
    const text =
      typeof rev.text === "string"
        ? rev.text
        : assertionName;

    await provider.updateRecord(
      row.logical_id,
      {
        name: assertionName,
        text,
        subject: nextSubject ?? undefined,
        object: nextObject,
        drefs: {
          ...(rev.drefs ?? {}),
          ...(nextSubject ? { subject: nextSubject } : {}),
          ...(nextObject ? { object: nextObject } : {}),
        },
        schema: {
          ...(rev.schema ?? {}),
          "@type": "Statement",
          name: assertionName,
          text,
        },
        updatedAt: now,
        provenance: {
          ...(rev.provenance ?? {}),
          sourceType: "graph_dedupe",
          extractionMethod: "clean_index_retarget",
          learnedAt: now,
          migratedFrom: logicalOf(fromDid),
        },
      },
      { reindex: false },
    );
    retargeted += 1;
  }

  return { retargeted, superseded };
}

async function findAssertion(
  provider: OipLocalMemoryProvider,
  subjectDid: string,
  predicate: string,
  objectDid: string,
  excludeLogicalId: string,
): Promise<string | null> {
  for (const row of provider.sqlite.listByType("Assertion", 20_000)) {
    if (row.logical_id === excludeLogicalId) continue;
    if (recordLooksSuperseded(row.name, row.search_text)) continue;
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (!rev?.predicate || revisionIsSuperseded(rev)) continue;
    if (String(rev.predicate) !== predicate) continue;
    if (rev.subject == null || asDid(String(rev.subject)) !== subjectDid) continue;
    if (rev.object == null || asDid(String(rev.object)) !== objectDid) continue;
    return asDid(row.id);
  }
  return null;
}

async function collapseDuplicateAssertions(
  provider: OipLocalMemoryProvider,
  now: string,
  onProgress?: DedupeProgressHandler,
): Promise<number> {
  const assertionHits = provider.sqlite.listByType("Assertion", 20_000);
  const buckets = new Map<string, string[]>();
  let scanned = 0;
  for (const row of assertionHits) {
    scanned += 1;
    if (!recordLooksSuperseded(row.name, row.search_text)) {
      const rev = await provider.packages.readCurrent(row.logical_id);
      if (rev?.predicate && rev.subject != null && rev.object != null && !revisionIsSuperseded(rev)) {
        const key = `${asDid(String(rev.subject))}|${rev.predicate}|${asDid(String(rev.object))}`;
        const list = buckets.get(key) ?? [];
        list.push(row.logical_id);
        buckets.set(key, list);
      }
    }
    if (onProgress && (scanned === assertionHits.length || scanned % 50 === 0)) {
      await onProgress({
        phase: "collapse",
        label: "Collapsing duplicate assertions…",
        current: scanned,
        total: assertionHits.length,
        percent: lerpPercent(80, 88, scanned, assertionHits.length),
      });
    }
  }

  let superseded = 0;
  for (const [, ids] of buckets) {
    if (ids.length < 2) continue;
    const keep = ids[0]!;
    for (const logicalId of ids.slice(1)) {
      const rev = await provider.packages.readCurrent(logicalId);
      if (!rev) continue;
      await provider.updateRecord(
        logicalId,
        {
          name: restoreDisplayName(rev.name) || "assertion",
          alfred: {
            ...((rev.alfred ?? {}) as Record<string, unknown>),
            supersededBy: asDid(keep),
          },
          updatedAt: now,
        },
        { reindex: false },
      );
      superseded += 1;
    }
  }
  return superseded;
}
