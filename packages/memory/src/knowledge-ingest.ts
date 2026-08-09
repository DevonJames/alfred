import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultMemoryPath,
  LOCAL_MEMORY_PROVIDER_ID,
  LocalFileMemoryProvider,
} from "./local-provider.js";
import {
  ingestMarkers,
  mergeUserMd,
  planIngestExport,
  type IngestExportResult,
} from "./ingest-export.js";
import {
  KnowledgeExportSchema,
  looksLikeKnowledgeExportJson,
  parseKnowledgeExportJson,
  type ExportConfidence,
  type KnowledgeExport,
} from "./knowledge-export-schema.js";
import {
  defaultOipMemoryRoot,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  OipLocalMemoryProvider,
} from "./oip-local/index.js";
import { defaultPersonaDir, ensurePersonaFiles } from "./persona.js";
import { SCHEMA_ORG } from "./oip-local/schema-org.js";

export interface KnowledgeIngestResult {
  mode: "json" | "markdown";
  providerId: string;
  filename: string;
  userMdUpdated: boolean;
  userSections: string[];
  artifactId?: string;
  created: {
    entities: number;
    episodes: number;
    assertions: number;
    observations: number;
    notes: number;
  };
  skippedSections: string[];
  root: string;
  userMdPath?: string;
  errors: string[];
}

function confidenceToScore(c: ExportConfidence): number {
  switch (c) {
    case "explicit":
      return 0.95;
    case "supported":
      return 0.75;
    case "tentative":
      return 0.45;
    case "superseded":
      return 0.2;
  }
}

function assertionType(c: ExportConfidence): "explicit" | "inferred" | "extracted" {
  if (c === "explicit") return "explicit";
  if (c === "supported") return "extracted";
  return "inferred";
}

/**
 * Ingest a knowledge export (JSON preferred, markdown supported).
 * - USER.md gets high-priority / how-to-work / negative prefs
 * - Remaining details become individual OIP (or JSONL) memory records
 */
export async function ingestKnowledgeDocument(opts: {
  filename: string;
  text: string;
  bytes?: Buffer;
  profileId?: string;
  providerId?: string;
  /** Persist raw bytes as artifact (OIP only). */
  storeArtifact?: boolean;
}): Promise<KnowledgeIngestResult> {
  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const providerId =
    opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID;
  const errors: string[] = [];
  const parsed = parseKnowledgeExportJson(opts.text);

  if (parsed.ok) {
    return ingestJsonExport({
      doc: parsed.data,
      filename: opts.filename,
      bytes: opts.bytes ?? Buffer.from(opts.text, "utf8"),
      profileId,
      providerId,
      storeArtifact: opts.storeArtifact !== false,
      errors,
    });
  }

  // Looks like our JSON export but failed validation — do not silently treat as markdown.
  if (looksLikeKnowledgeExportJson(opts.text, opts.filename)) {
    const detail = parsed.issues.slice(0, 12).join("; ");
    throw new Error(
      `Knowledge-export JSON failed validation (${parsed.reason}): ${detail || "unknown error"}` +
        (parsed.issues.length > 12 ? ` (+${parsed.issues.length - 12} more)` : ""),
    );
  }

  return ingestMarkdownExport({
    text: opts.text,
    filename: opts.filename,
    bytes: opts.bytes ?? Buffer.from(opts.text, "utf8"),
    profileId,
    providerId,
    storeArtifact: opts.storeArtifact !== false,
    errors,
  });
}

async function writeUserPatch(
  profileId: string,
  userPatch: string,
  markers: { start: string; end: string },
  sourceLabel: string,
): Promise<{ updated: boolean; path: string; sections: string[] }> {
  if (!userPatch.trim()) {
    return { updated: false, path: "", sections: [] };
  }
  const personaDir = defaultPersonaDir(profileId);
  await ensurePersonaFiles(personaDir);
  const userPath = path.join(personaDir, "USER.md");
  let existing = "";
  try {
    existing = await readFile(userPath, "utf8");
  } catch {
    existing = "# USER.md — User Model\n";
  }
  const merged = mergeUserMd(existing, userPatch, markers);
  await writeFile(userPath, merged, "utf8");
  void sourceLabel;

  return {
    updated: true,
    path: userPath,
    sections: extractSectionTitles(userPatch),
  };
}

function extractSectionTitles(patch: string): string[] {
  return [...patch.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
}

async function archiveExport(
  profileId: string,
  filename: string,
  text: string,
): Promise<void> {
  const personaDir = defaultPersonaDir(profileId);
  const dataRoot = path.dirname(path.dirname(personaDir));
  const archiveDir = path.join(dataRoot, "knowledge", "exports");
  await mkdir(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.parse(filename).name || "export";
  await writeFile(path.join(archiveDir, `${base}-${stamp}${path.extname(filename) || ".md"}`), text, "utf8");
}

async function ingestJsonExport(opts: {
  doc: KnowledgeExport;
  filename: string;
  bytes: Buffer;
  profileId: string;
  providerId: string;
  storeArtifact: boolean;
  errors: string[];
}): Promise<KnowledgeIngestResult> {
  const doc = KnowledgeExportSchema.parse(opts.doc);
  const markers = ingestMarkers(opts.filename);
  const pieces: { key: string; body: string }[] = [
    {
      key: "High-Priority Persistent Context",
      body: doc.userPatch.highPriorityPersistentContext.trim(),
    },
    {
      key: "How to Work Effectively With Me",
      body: doc.userPatch.howToWorkEffectivelyWithMe.trim(),
    },
  ];
  if (doc.userPatch.negativePreferences?.trim()) {
    pieces.push({
      key: "Negative Preferences",
      body: doc.userPatch.negativePreferences.trim(),
    });
  }
  const userPatch = buildMarkerPatch(pieces, markers);
  const user = await writeUserPatch(opts.profileId, userPatch, markers, opts.filename);
  await archiveExport(opts.profileId, opts.filename, JSON.stringify(doc, null, 2));

  const created = {
    entities: 0,
    episodes: 0,
    assertions: 0,
    observations: 0,
    notes: 0,
  };

  if (
    opts.providerId === OIP_LOCAL_MEMORY_PROVIDER_ID ||
    opts.providerId === "memory.oip-local"
  ) {
    const root = defaultOipMemoryRoot(opts.profileId);
    const provider = new OipLocalMemoryProvider(root);
    const now = new Date().toISOString();
    let artifactId: string | undefined;

    if (opts.storeArtifact) {
      const artifact = await provider.putArtifactBytes(opts.bytes, {
        mimeType: "application/json",
        originalFilename: opts.filename,
        name: opts.filename,
        reindex: false,
      });
      artifactId = artifact.id;
    }

    const tempToDid = new Map<string, string>();

    // Pass 1: entities
    for (const ent of doc.entities) {
      try {
        const record = await provider.createRecord("Entity", {
          name: ent.name,
          schemaType: ent.schemaType,
          schema: {
            "@type": ent.entityClass,
            name: ent.name,
            ...(ent.aliases.length ? { alternateName: ent.aliases } : {}),
            ...(ent.summary ? { description: ent.summary } : {}),
          },
          alfred: {
            entityClass: ent.entityClass,
            confidence: confidenceToScore(ent.confidence),
            confidenceLabel:
              ent.confidence === "explicit"
                ? "confirmed"
                : ent.confidence === "supported"
                  ? "high"
                  : ent.confidence === "tentative"
                    ? "low"
                    : "inferred",
            visibility: "private",
            assertionType: assertionType(ent.confidence),
          },
          learnedAt: now,
          provenance: {
            sourceType: "knowledge_export_json",
            learnedAt: now,
            extractionMethod: "knowledge_ingest",
            source: artifactId,
            confidence: confidenceToScore(ent.confidence),
          },
          drefs: artifactId ? { sourceArtifact: artifactId } : {},
        }, undefined, { reindex: false });
        tempToDid.set(ent.tempId, record.id);
        created.entities += 1;
      } catch (e) {
        opts.errors.push(`entity ${ent.tempId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Pass 1b: entity relationships as assertions
    for (const ent of doc.entities) {
      const subjectDid = tempToDid.get(ent.tempId);
      if (!subjectDid) continue;
      for (const rel of ent.relationships) {
        const objectDid = tempToDid.get(rel.objectTempId);
        if (!objectDid) {
          opts.errors.push(
            `relationship ${ent.tempId}.${rel.predicate}: missing ${rel.objectTempId}`,
          );
          continue;
        }
        try {
          await provider.createRecord("Assertion", {
            name: `${ent.name} ${rel.predicate}`,
            subject: subjectDid,
            predicate: rel.predicate,
            object: objectDid,
            schema: {
              "@type": "Statement",
              name: `${ent.name} ${rel.predicate}`,
            },
            drefs: { subject: subjectDid, object: objectDid },
            alfred: {
              assertionType: assertionType(ent.confidence),
              confidence: confidenceToScore(ent.confidence),
              visibility: "private",
            },
            learnedAt: now,
            provenance: {
              sourceType: "knowledge_export_json",
              learnedAt: now,
              source: artifactId,
            },
          }, undefined, { reindex: false });
          created.assertions += 1;
        } catch (e) {
          opts.errors.push(
            `rel ${ent.tempId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // Episodes
    for (const ep of doc.episodes) {
      try {
        const participants = ep.participantTempIds
          .map((t) => tempToDid.get(t))
          .filter((x): x is string => !!x);
        const involved = ep.involvedTempIds
          .map((t) => tempToDid.get(t))
          .filter((x): x is string => !!x);
        const location = ep.locationTempId ? tempToDid.get(ep.locationTempId) : undefined;
        const record = await provider.createRecord("Episode", {
          name: ep.name,
          text: ep.summary,
          schemaType: SCHEMA_ORG.Event,
          schema: {
            "@type": "Event",
            name: ep.name,
            description: ep.summary,
          },
          participants,
          location,
          validTimeStart: ep.start,
          validTimeEnd: ep.end,
          drefs: {
            ...(location ? { occurredAt: location } : {}),
            ...(involved.length ? { involved } : {}),
            ...(artifactId ? { sourceArtifact: artifactId } : {}),
          },
          alfred: {
            confidence: confidenceToScore(ep.confidence),
            visibility: "private",
            assertionType: assertionType(ep.confidence),
          },
          learnedAt: now,
          provenance: {
            sourceType: "knowledge_export_json",
            learnedAt: now,
            source: artifactId,
          },
        }, undefined, { reindex: false });
        tempToDid.set(ep.tempId, record.id);
        created.episodes += 1;
      } catch (e) {
        opts.errors.push(`episode ${ep.tempId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Assertions
    for (const a of doc.assertions) {
      try {
        const subject = tempToDid.get(a.subjectTempId);
        if (!subject) {
          opts.errors.push(`assertion ${a.tempId}: missing subject ${a.subjectTempId}`);
          continue;
        }
        const objectDid = a.objectTempId ? tempToDid.get(a.objectTempId) : undefined;
        const object = objectDid ?? a.objectText ?? null;
        const record = await provider.createRecord("Assertion", {
          name: a.summary,
          text: a.summary,
          subject,
          predicate: a.predicate,
          object,
          validFrom: a.validFrom ?? null,
          validUntil: a.validUntil ?? null,
          schema: { "@type": "Statement", name: a.summary },
          drefs: {
            subject,
            ...(objectDid ? { object: objectDid } : {}),
            ...(artifactId ? { sourceArtifact: artifactId } : {}),
          },
          alfred: {
            assertionType: assertionType(a.confidence),
            confidence: confidenceToScore(a.confidence),
            confidenceLabel:
              a.confidence === "explicit"
                ? "high"
                : a.confidence === "supported"
                  ? "medium"
                  : "low",
            visibility: "private",
          },
          learnedAt: a.learnedAt ?? now,
          provenance: {
            sourceType: "knowledge_export_json",
            learnedAt: now,
            source: artifactId,
            confidence: confidenceToScore(a.confidence),
          },
        }, undefined, { reindex: false });
        tempToDid.set(a.tempId, record.id);
        created.assertions += 1;
      } catch (e) {
        opts.errors.push(`assertion ${a.tempId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Atomic memories → Observations
    for (const m of doc.memories) {
      try {
        const related = m.relatedTempIds
          .map((t) => tempToDid.get(t))
          .filter((x): x is string => !!x);
        await provider.createRecord("Observation", {
          name: m.title,
          text: m.text,
          observedAt: now,
          schemaType: "https://schema.org/CreativeWork",
          schema: {
            "@type": "CreativeWork",
            name: m.title,
            text: m.text,
            keywords: m.topics.join(", "),
          },
          drefs: {
            ...(related.length ? { related } : {}),
            ...(artifactId ? { sourceArtifact: artifactId } : {}),
          },
          alfred: {
            confidence: confidenceToScore(m.confidence),
            visibility: "private",
            assertionType: assertionType(m.confidence),
            entityClass: m.kind,
          },
          validFrom: m.validFrom ?? null,
          validUntil: m.validUntil ?? null,
          learnedAt: now,
          provenance: {
            sourceType: "knowledge_export_json",
            learnedAt: now,
            source: artifactId,
            extractionMethod: m.kind,
            confidence: confidenceToScore(m.confidence),
          },
        }, undefined, { reindex: false });
        created.observations += 1;
      } catch (e) {
        opts.errors.push(`memory ${m.tempId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Stale / gaps as low-confidence observations
    for (const [i, line] of doc.potentiallyStale.entries()) {
      await provider.createRecord("Observation", {
        name: `Potentially stale: ${line.slice(0, 80)}`,
        text: line,
        observedAt: now,
        schema: { "@type": "CreativeWork", name: "potentially_stale", text: line },
        alfred: {
          confidence: 0.3,
          confidenceLabel: "low",
          visibility: "private",
          assertionType: "inferred",
          entityClass: "stale_flag",
        },
        learnedAt: now,
        provenance: { sourceType: "knowledge_export_json", source: artifactId },
        drefs: artifactId ? { sourceArtifact: artifactId } : {},
      }, undefined, { reindex: false });
      created.observations += 1;
      void i;
    }

    await provider.rebuildIndexes();

    return {
      mode: "json",
      providerId: OIP_LOCAL_MEMORY_PROVIDER_ID,
      filename: opts.filename,
      userMdUpdated: user.updated,
      userSections: user.sections,
      artifactId,
      created,
      skippedSections: doc.knowledgeGaps.map((g) => `gap:${g.slice(0, 60)}`),
      root,
      userMdPath: user.path || undefined,
      errors: opts.errors,
    };
  }

  // JSONL fallback — flatten to notes
  const filePath = defaultMemoryPath(opts.profileId);
  const local = new LocalFileMemoryProvider(filePath, LOCAL_MEMORY_PROVIDER_ID);
  const records = [
    ...doc.memories.map((m) => ({
      id: `mem_json_${m.tempId}`,
      content: `${m.title}: ${m.text}`,
      createdAt: new Date().toISOString(),
      metadata: { kind: "note" as const, sourceId: `export:${m.tempId}`, confidence: m.confidence },
    })),
    ...doc.assertions.map((a) => ({
      id: `mem_json_${a.tempId}`,
      content: a.summary,
      createdAt: new Date().toISOString(),
      metadata: { kind: "fact" as const, sourceId: `export:${a.tempId}` },
    })),
  ];
  await local.importCanonical(records);
  created.notes = records.length;

  return {
    mode: "json",
    providerId: LOCAL_MEMORY_PROVIDER_ID,
    filename: opts.filename,
    userMdUpdated: user.updated,
    userSections: user.sections,
    created,
    skippedSections: [],
    root: filePath,
    userMdPath: user.path || undefined,
    errors: opts.errors,
  };
}

async function ingestMarkdownExport(opts: {
  text: string;
  filename: string;
  bytes: Buffer;
  profileId: string;
  providerId: string;
  storeArtifact: boolean;
  errors: string[];
}): Promise<KnowledgeIngestResult> {
  const planned: IngestExportResult = planIngestExport(opts.text, {
    sourceLabel: opts.filename,
  });
  const user = await writeUserPatch(
    opts.profileId,
    planned.userPatch,
    planned.markers,
    opts.filename,
  );
  await archiveExport(opts.profileId, opts.filename, opts.text);

  const created = {
    entities: 0,
    episodes: 0,
    assertions: 0,
    observations: 0,
    notes: 0,
  };

  if (
    opts.providerId === OIP_LOCAL_MEMORY_PROVIDER_ID ||
    opts.providerId === "memory.oip-local"
  ) {
    const root = defaultOipMemoryRoot(opts.profileId);
    const provider = new OipLocalMemoryProvider(root);
    const now = new Date().toISOString();
    let artifactId: string | undefined;
    if (opts.storeArtifact) {
      const artifact = await provider.putArtifactBytes(opts.bytes, {
        mimeType: "text/markdown",
        originalFilename: opts.filename,
        name: opts.filename,
        reindex: false,
      });
      artifactId = artifact.id;
    }

    for (const rec of planned.memoryRecords) {
      try {
        await provider.createRecord("Observation", {
          name: String(rec.metadata?.section ?? rec.metadata?.sourceId ?? "export note"),
          text: rec.content,
          observedAt: now,
          schemaType: "https://schema.org/CreativeWork",
          schema: {
            "@type": "CreativeWork",
            name: String(rec.metadata?.section ?? "export note"),
            text: rec.content,
          },
          alfred: {
            confidence: 0.85,
            visibility: "private",
            assertionType: "extracted",
            entityClass: "note",
          },
          drefs: artifactId ? { sourceArtifact: artifactId } : {},
          learnedAt: now,
          provenance: {
            sourceType: "knowledge_export_markdown",
            learnedAt: now,
            source: artifactId,
            extractionMethod: "ingest-export-chunk",
          },
        }, undefined, { reindex: false });
        created.observations += 1;
      } catch (e) {
        opts.errors.push(
          `${rec.metadata?.sourceId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    await provider.rebuildIndexes();

    return {
      mode: "markdown",
      providerId: OIP_LOCAL_MEMORY_PROVIDER_ID,
      filename: opts.filename,
      userMdUpdated: user.updated,
      userSections: user.sections.length ? user.sections : planned.userSectionsFound,
      artifactId,
      created,
      skippedSections: planned.skippedSections,
      root,
      userMdPath: user.path || undefined,
      errors: opts.errors,
    };
  }

  const filePath = defaultMemoryPath(opts.profileId);
  const local = new LocalFileMemoryProvider(filePath, LOCAL_MEMORY_PROVIDER_ID);
  if (planned.memoryRecords.length) {
    await local.importCanonical(planned.memoryRecords);
    created.notes = planned.memoryRecords.length;
  }

  return {
    mode: "markdown",
    providerId: LOCAL_MEMORY_PROVIDER_ID,
    filename: opts.filename,
    userMdUpdated: user.updated,
    userSections: planned.userSectionsFound,
    created,
    skippedSections: planned.skippedSections,
    root: filePath,
    userMdPath: user.path || undefined,
    errors: opts.errors,
  };
}

function buildMarkerPatch(
  pieces: { key: string; body: string }[],
  markers: { start: string; end: string },
): string {
  const order = [
    "High-Priority Persistent Context",
    "How to Work Effectively With Me",
    "Negative Preferences",
  ];
  const byKey = new Map(pieces.map((p) => [p.key, p.body]));
  const blocks: string[] = [];
  for (const key of order) {
    const body = byKey.get(key);
    if (!body) continue;
    blocks.push(`## ${key}\n\n${body}`);
  }
  return `${markers.start}\n\n${blocks.join("\n\n")}\n\n${markers.end}`;
}

/**
 * Delete canonical OIP memory store for a profile (packages, artifacts, indexes).
 */
export async function eraseOipMemory(opts?: {
  profileId?: string;
  /** Also clear memory.local JSONL */
  includeLocalJsonl?: boolean;
}): Promise<{ oipRoot: string; removed: string[]; jsonlPath?: string }> {
  const { rm } = await import("node:fs/promises");
  const profileId = opts?.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const oipRoot = defaultOipMemoryRoot(profileId);
  const removed: string[] = [];

  for (const sub of ["memory", "artifacts", "indexes"]) {
    const p = path.join(oipRoot, sub);
    await rm(p, { recursive: true, force: true });
    removed.push(p);
  }
  // Keep storage-format.json or remove whole root contents
  await rm(path.join(oipRoot, "storage-format.json"), { force: true });

  let jsonlPath: string | undefined;
  if (opts?.includeLocalJsonl) {
    jsonlPath = defaultMemoryPath(profileId);
    await rm(jsonlPath, { force: true });
    removed.push(jsonlPath);
  }

  return { oipRoot, removed, jsonlPath };
}
