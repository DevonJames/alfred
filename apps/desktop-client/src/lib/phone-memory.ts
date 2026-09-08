/**
 * Shape the phone's Memory detail screen expects (§11.2 / iOS Memory type).
 * Built from an OIP package revision + optional graph neighbors.
 */
import type { MemoryRevision } from "@alfred/memory";

export interface PhoneArtifactRef {
  id: string;
  hash: string;
  hashAlgorithm: string;
  filename: string;
  mimeType: string;
  byteLength: number;
  available: boolean;
  url: string;
}

export type PhoneMemoryKind = "entity" | "episode" | "note";

export interface PhoneMemory {
  id: string;
  kind: PhoneMemoryKind;
  entityType: string | null;
  title: string;
  summary: string;
  revision: number;
  processingState: "stored" | "extracting" | "indexed" | "needs_resolution";
  confidence: "remembered" | "likely" | "ambiguous" | "inferred" | "unknown";
  needsResolution: { field: string; question: string; options: string[] }[];
  occurredAt: string | null;
  visibility: "private" | "public";
  owner: string;
  reminder: {
    dueAt: string;
    dateOnly: boolean;
    timezone: string;
    status: "pending" | "completed" | "dismissed" | "snoozed";
    surfacedAt: string | null;
    snoozedUntil: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  artifactsForgotten: boolean;
  artifacts: PhoneArtifactRef[];
  assertions: {
    id: string;
    text: string;
    confidence: PhoneMemory["confidence"];
    revision: number;
    current: boolean;
    supersedes: string | null;
    supersededBy: string | null;
    sourceKind: string;
    createdAt: string;
  }[];
  related: {
    id: string;
    title: string;
    kind: PhoneMemoryKind;
    entityType: string | null;
    relation: string;
  }[];
}

function kindFromType(type: string | undefined): PhoneMemoryKind {
  if (type === "Entity") return "entity";
  if (type === "Episode") return "episode";
  return "note";
}

function confidenceFromRevision(rev: MemoryRevision): PhoneMemory["confidence"] {
  const label = rev.alfred?.confidenceLabel;
  if (label === "confirmed" || label === "high") return "remembered";
  if (label === "medium") return "likely";
  if (label === "low") return "ambiguous";
  if (label === "inferred" || rev.alfred?.assertionType === "inferred") return "inferred";
  if (typeof rev.alfred?.confidence === "number") {
    if (rev.alfred.confidence >= 0.85) return "remembered";
    if (rev.alfred.confidence >= 0.55) return "likely";
    if (rev.alfred.confidence >= 0.3) return "ambiguous";
  }
  return "unknown";
}

function reminderFromRevision(rev: MemoryRevision): PhoneMemory["reminder"] {
  if (!rev.remindAt) return null;
  const status = (rev.reminderStatus ?? "pending") as NonNullable<PhoneMemory["reminder"]>["status"];
  return {
    dueAt: rev.remindAt,
    dateOnly: !rev.remindAt.includes("T"),
    timezone: rev.reminderTimezone ?? "",
    status: ["pending", "completed", "dismissed", "snoozed"].includes(status) ? status : "pending",
    surfacedAt: rev.reminderLastSurfacedAt ?? null,
    snoozedUntil: rev.reminderSnoozedUntil ?? null,
  };
}

function bodyText(rev: MemoryRevision): string {
  const schema = rev.schema ?? {};
  return (
    rev.text ||
    (typeof schema.description === "string" ? schema.description : "") ||
    (typeof schema.text === "string" ? schema.text : "") ||
    (rev.predicate ? `${rev.predicate} → ${rev.object ?? ""}` : "") ||
    rev.name ||
    ""
  );
}

export function sourceArtifactIdFromRevision(rev: MemoryRevision | null | undefined): string | null {
  if (!rev) return null;
  const fromDrefs = rev.drefs?.sourceArtifact;
  if (typeof fromDrefs === "string" && fromDrefs.trim()) return fromDrefs.trim();
  if (typeof rev.sourceArtifact === "string" && rev.sourceArtifact.trim()) return rev.sourceArtifact.trim();
  return null;
}

export function artifactRefFromRevision(rev: MemoryRevision | null | undefined): PhoneArtifactRef | null {
  if (!rev || (rev.type !== "Artifact" && !rev.contentHash && !rev.mimeType)) return null;
  const hash = typeof rev.contentHash === "string" ? rev.contentHash : "";
  const filename = rev.originalFilename || rev.name || "file";
  const mimeType = rev.mimeType || (typeof rev.schema?.encodingFormat === "string" ? rev.schema.encodingFormat : "") || "";
  return {
    id: rev.id,
    hash,
    hashAlgorithm: hash.startsWith("sha256:") ? "sha256" : "sha256",
    filename,
    mimeType,
    byteLength: typeof rev.byteSize === "number" ? rev.byteSize : 0,
    available: Boolean(hash),
    url: `/memory/graph/artifact/${encodeURIComponent(rev.id)}`,
  };
}

export function revisionToPhoneMemory(
  rev: MemoryRevision,
  opts?: {
    related?: PhoneMemory["related"];
    artifacts?: PhoneArtifactRef[];
    score?: number;
    via?: "lexical" | "semantic" | "graph";
  },
): PhoneMemory {
  const text = bodyText(rev).trim();
  const title = rev.name?.trim() || text.slice(0, 80) || rev.type;
  const confidence = confidenceFromRevision(rev);
  const rawRev = String(rev.revision ?? "1");
  const digits = rawRev.replace(/\D/g, "");
  const parsed = digits ? Number.parseInt(digits.slice(0, 4), 10) : 1;
  const revisionNum =
    Number.isFinite(parsed) && parsed >= 1 && parsed < 10_000 ? parsed : 1;

  const assertions: PhoneMemory["assertions"] = [];
  if (text) {
    assertions.push({
      id: `${rev.id}#claim`,
      text,
      confidence,
      revision: revisionNum,
      current: true,
      supersedes: rev.previousRevision ? `${rev.id}#${rev.previousRevision}` : null,
      supersededBy: null,
      sourceKind: rev.provenance?.sourceType ?? rev.type.toLowerCase(),
      createdAt: rev.createdAt,
    });
  }

  const memory: PhoneMemory = {
    id: rev.id,
    kind: kindFromType(rev.type),
    entityType: rev.type === "Entity" ? (rev.alfred?.entityClass ?? rev.schemaType ?? "Thing") : null,
    title,
    summary: text && text !== title ? text : "",
    revision: revisionNum,
    processingState: "indexed",
    confidence,
    needsResolution: [],
    occurredAt: rev.observedAt ?? rev.validTimeStart ?? rev.learnedAt ?? null,
    visibility: rev.alfred?.visibility === "public" ? "public" : "private",
    owner: rev.alfred?.owner ?? "",
    reminder: reminderFromRevision(rev),
    createdAt: rev.createdAt,
    updatedAt: rev.updatedAt,
    artifactsForgotten: false,
    artifacts: opts?.artifacts ?? [],
    assertions,
    related: opts?.related ?? [],
  };

  if (opts?.score != null) (memory as PhoneMemory & { score?: number }).score = opts.score;
  if (opts?.via) (memory as PhoneMemory & { via?: string }).via = opts.via;
  return memory;
}

export function phoneKindMatches(
  kind: PhoneMemoryKind,
  allowed: string[] | undefined,
): boolean {
  if (!allowed?.length) return true;
  return allowed.includes(kind);
}

/** Map ask/search model labels onto the phone Confidence enum. */
export function toPhoneAskConfidence(
  raw: string | undefined,
): PhoneMemory["confidence"] {
  switch ((raw ?? "").toLowerCase()) {
    case "high":
    case "remembered":
    case "confirmed":
      return "remembered";
    case "medium":
    case "likely":
      return "likely";
    case "low":
    case "ambiguous":
      return "ambiguous";
    case "inferred":
      return "inferred";
    default:
      return "unknown";
  }
}

export function phoneAskSource(memory: PhoneMemory, score = 0, via = "semantic") {
  return {
    id: memory.id,
    title: memory.title,
    kind: memory.kind,
    score,
    via,
    occurredAt: memory.occurredAt,
    assertionIds: memory.assertions.filter((a) => a.current).map((a) => a.id),
  };
}
