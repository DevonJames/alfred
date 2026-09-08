import {
  defaultOipMemoryRoot,
  OIP_LOCAL_MEMORY_PROVIDER_ID,
  OipLocalMemoryProvider,
} from "./oip-local/index.js";
import { hashBytes } from "./oip-local/hashing.js";
import { SCHEMA_ORG } from "./oip-local/schema-org.js";
import type { MemoryRevision } from "./oip-local/schemas.js";

export const AUDIO_NOTE_TEMPLATES = ["meeting", "brainstorm", "checkin", "freeform"] as const;
export type AudioNoteTemplate = (typeof AUDIO_NOTE_TEMPLATES)[number];

export interface AudioNoteActionItem {
  text: string;
  assignee?: string;
  dueDate?: string;
}

export interface AudioNoteMetadata {
  summary: string;
  takeaways: string[];
  nextSteps: AudioNoteActionItem[];
  openQuestions: string[];
  attendees: string[];
  template: AudioNoteTemplate;
  location?: string;
}

export type AudioNoteProcessingStatus = "processing" | "completed" | "failed";

export interface AudioNoteIngestResult {
  mode: "audio_note";
  providerId: string;
  filename: string;
  artifactId: string;
  fileEntityId: string;
  episodeId: string;
  created: {
    entities: number;
    episodes: number;
    assertions: number;
    observations: number;
    notes: number;
  };
  root: string;
  errors: string[];
}

const TRANSCRIPT_CHUNK_CHARS = 2200;

function audioNoteProvenance(opts: {
  filename: string;
  contentHash: string;
  learnedAt: string;
  noteName: string;
  extractionMethod: string;
}): Record<string, unknown> {
  return {
    sourceType: "audio_note",
    extractionMethod: opts.extractionMethod,
    originalFilename: opts.filename,
    relPath: opts.filename,
    contentHash: opts.contentHash,
    learnedAt: opts.learnedAt,
    noteName: opts.noteName,
  };
}

export function isAudioNoteFilename(filename: string): boolean {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return (
    ext === "m4a" ||
    ext === "aac" ||
    ext === "mp3" ||
    ext === "wav" ||
    ext === "webm" ||
    ext === "ogg" ||
    ext === "flac" ||
    ext === "caf"
  );
}

export function audioMimeFromFilename(filename: string, fallback?: string): string {
  if (fallback && fallback.startsWith("audio/")) return fallback;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "m4a" || ext === "aac") return "audio/mp4";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "webm") return "audio/webm";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "flac") return "audio/flac";
  if (ext === "caf") return "audio/x-caf";
  return fallback?.trim() || "audio/mp4";
}

export async function upsertAudioNoteFolderEntity(
  provider: OipLocalMemoryProvider,
  label: string,
  learnedAt: string,
): Promise<MemoryRevision> {
  const name = label.trim();
  const body = {
    name,
    text: name,
    schemaType: SCHEMA_ORG.Collection,
    schema: { "@type": "Collection", name },
    alfred: { entityClass: "audio_note_folder", visibility: "private" as const, confidence: 1 },
    learnedAt,
    provenance: {
      sourceType: "audio_note",
      extractionMethod: "audio_note_folder",
      folderLabel: name,
      learnedAt,
    },
  };
  const named = provider.sqlite.findByName(name, "Entity");
  const hit = named.find((r) =>
    /audio_note_folder|docs_folder|photo_album|collection/i.test(`${r.schema_type ?? ""} ${r.search_text ?? ""}`),
  );
  if (hit) {
    const current = await provider.packages.readCurrent(hit.logical_id);
    if (current) return current;
  }
  return provider.createRecord("Entity", body, undefined, { reindex: false });
}

export function emptyAudioNoteMetadata(template: AudioNoteTemplate = "freeform"): AudioNoteMetadata {
  return {
    summary: "",
    takeaways: [],
    nextSteps: [],
    openQuestions: [],
    attendees: [],
    template,
    location: undefined,
  };
}

export function chunkTranscript(text: string): Array<{ key: string; title: string; text: string }> {
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (!cleaned) return [];
  const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  let buf = "";
  const pushBuf = () => {
    const next = buf.trim();
    if (next) pieces.push(next);
    buf = "";
  };
  for (const para of paragraphs.length ? paragraphs : [cleaned]) {
    if (!buf) {
      buf = para;
      continue;
    }
    if (`${buf}\n\n${para}`.length <= TRANSCRIPT_CHUNK_CHARS) {
      buf = `${buf}\n\n${para}`;
    } else {
      pushBuf();
      buf = para;
    }
  }
  pushBuf();

  const oversized: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= TRANSCRIPT_CHUNK_CHARS) {
      oversized.push(piece);
      continue;
    }
    for (let i = 0; i < piece.length; i += TRANSCRIPT_CHUNK_CHARS) {
      oversized.push(piece.slice(i, i + TRANSCRIPT_CHUNK_CHARS).trim());
    }
  }

  return oversized
    .filter(Boolean)
    .map((chunk, index) => ({
      key: `transcript-${index + 1}`,
      title: oversized.length === 1 ? "Transcript" : `Transcript (${index + 1})`,
      text: chunk,
    }));
}

function providerFor(opts: { profileId?: string; providerId?: string }): {
  provider: OipLocalMemoryProvider;
  profileId: string;
  providerId: string;
  root: string;
} {
  const profileId = opts.profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  const providerId =
    opts.providerId ?? process.env.ALFRED_MEMORY_PROVIDER_ID ?? OIP_LOCAL_MEMORY_PROVIDER_ID;
  if (providerId !== OIP_LOCAL_MEMORY_PROVIDER_ID && providerId !== "memory.oip-local") {
    throw new Error("Audio note ingest requires the local OIP memory provider");
  }
  const root = defaultOipMemoryRoot(profileId);
  return { provider: new OipLocalMemoryProvider(root), profileId, providerId, root };
}

function episodeSchema(opts: {
  title: string;
  metadata: AudioNoteMetadata;
  transcript: string;
  processingStatus: AudioNoteProcessingStatus;
  filename: string;
  mimeType: string;
  durationSeconds?: number;
}): Record<string, unknown> {
  return {
    "@type": "Event",
    name: opts.title,
    description: opts.metadata.summary,
    takeaways: opts.metadata.takeaways,
    nextSteps: opts.metadata.nextSteps,
    openQuestions: opts.metadata.openQuestions,
    attendees: opts.metadata.attendees,
    template: opts.metadata.template,
    ...(opts.metadata.location ? { location: opts.metadata.location } : {}),
    transcript: opts.transcript,
    processingStatus: opts.processingStatus,
    encodingFormat: opts.mimeType,
    originalFilename: opts.filename,
    ...(opts.durationSeconds != null ? { durationSeconds: opts.durationSeconds } : {}),
  };
}

async function writeObservations(
  provider: OipLocalMemoryProvider,
  opts: {
    title: string;
    filename: string;
    contentHash: string;
    learnedAt: string;
    metadata: AudioNoteMetadata;
    transcript: string;
    artifactId: string;
    episodeId: string;
  },
): Promise<number> {
  let count = 0;
  const base = {
    schemaType: SCHEMA_ORG.CreativeWork,
    alfred: { visibility: "private" as const, confidence: 1, assertionType: "explicit" as const },
    learnedAt: opts.learnedAt,
    observedAt: opts.learnedAt,
    drefs: {
      isPartOf: opts.episodeId,
      sourceArtifact: opts.artifactId,
    },
  };

  const add = async (
    name: string,
    text: string,
    extractionMethod: string,
    extra: Record<string, unknown> = {},
  ) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    await provider.createRecord(
      "Observation",
      {
        ...base,
        name,
        text: cleaned,
        schema: { "@type": "CreativeWork", name, text: cleaned },
        provenance: audioNoteProvenance({
          filename: opts.filename,
          contentHash: opts.contentHash,
          learnedAt: opts.learnedAt,
          noteName: opts.title,
          extractionMethod,
        }),
        ...extra,
      },
      undefined,
      { reindex: false },
    );
    count += 1;
  };

  if (opts.metadata.location) {
    await add(`${opts.title} · location`, opts.metadata.location, "audio_note_location");
  }
  await add(`${opts.title} · summary`, opts.metadata.summary, "audio_note_summary");
  for (const [i, takeaway] of opts.metadata.takeaways.entries()) {
    await add(`${opts.title} · takeaway ${i + 1}`, takeaway, "audio_note_takeaway");
  }
  for (const [i, step] of opts.metadata.nextSteps.entries()) {
    const bits = [step.text.trim()];
    if (step.assignee) bits.push(`assignee=${step.assignee}`);
    if (step.dueDate) bits.push(`due=${step.dueDate}`);
    const due = parseNoteDueDate(step.dueDate);
    await add(`${opts.title} · action ${i + 1}`, `Action: ${bits.join(" · ")}`, "audio_note_action", {
      ...(due
        ? {
            remindAt: due,
            reminderStatus: "pending",
            reminderReason: "audio_note_action",
          }
        : {}),
    });
  }
  for (const [i, question] of opts.metadata.openQuestions.entries()) {
    await add(`${opts.title} · question ${i + 1}`, question, "audio_note_question");
  }
  for (const chunk of chunkTranscript(opts.transcript)) {
    await add(`${opts.title} · ${chunk.title}`, chunk.text, "audio_note_transcript");
  }
  return count;
}

/**
 * Persist the original recording as an Artifact + AudioObject file entity.
 * Used for both the sync ingest path and the async job stub.
 */
export async function storeAudioNoteFile(opts: {
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  profileId?: string;
  providerId?: string;
  noteName?: string;
}): Promise<{
  artifactId: string;
  fileEntityId: string;
  contentHash: string;
  mimeType: string;
  root: string;
  provider: OipLocalMemoryProvider;
}> {
  const { provider, root } = providerFor(opts);
  const mimeType = audioMimeFromFilename(opts.filename, opts.mimeType);
  const learnedAt = new Date().toISOString();
  const contentHash = hashBytes(opts.bytes);
  const noteName = opts.noteName?.trim() || opts.filename;

  const artifact = await provider.putArtifactBytes(opts.bytes, {
    mimeType,
    originalFilename: opts.filename,
    name: opts.filename,
    reindex: false,
  });

  const file = await provider.createRecord(
    "Entity",
    {
      name: opts.filename,
      text: noteName,
      schemaType: SCHEMA_ORG.AudioObject,
      schema: {
        "@type": "AudioObject",
        name: opts.filename,
        encodingFormat: mimeType,
        description: noteName,
      },
      alfred: { entityClass: "audio_note_file", visibility: "private" as const, confidence: 1 },
      learnedAt,
      contentHash,
      originalFilename: opts.filename,
      mimeType,
      provenance: audioNoteProvenance({
        filename: opts.filename,
        contentHash,
        learnedAt,
        noteName,
        extractionMethod: "audio_note_file",
      }),
      drefs: { sourceArtifact: artifact.id },
    },
    undefined,
    { reindex: false },
  );

  return {
    artifactId: artifact.id,
    fileEntityId: file.id,
    contentHash,
    mimeType,
    root,
    provider,
  };
}

export async function beginAudioNote(opts: {
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  title?: string;
  template?: AudioNoteTemplate;
  attendees?: string[];
  location?: string;
  folderDid?: string;
  recordedAt?: string;
  durationSeconds?: number;
  profileId?: string;
  providerId?: string;
}): Promise<AudioNoteIngestResult> {
  const stored = await storeAudioNoteFile(opts);
  const learnedAt = opts.recordedAt ?? new Date().toISOString();
  const title = opts.title?.trim() || opts.filename.replace(/\.[^.]+$/, "") || "Audio note";
  const metadata = emptyAudioNoteMetadata(opts.template ?? "freeform");
  metadata.attendees = (opts.attendees ?? []).map((a) => a.trim()).filter(Boolean);
  if (opts.location?.trim()) metadata.location = opts.location.trim();

  const episode = await stored.provider.createRecord(
    "Episode",
    {
      name: title,
      text: "",
      schemaType: SCHEMA_ORG.Event,
      schema: episodeSchema({
        title,
        metadata,
        transcript: "",
        processingStatus: "processing",
        filename: opts.filename,
        mimeType: stored.mimeType,
        durationSeconds: opts.durationSeconds,
      }),
      alfred: {
        entityClass: metadata.template,
        visibility: "private" as const,
        confidence: 1,
        assertionType: "explicit" as const,
      },
      learnedAt,
      validTimeStart: learnedAt,
      provenance: audioNoteProvenance({
        filename: opts.filename,
        contentHash: stored.contentHash,
        learnedAt,
        noteName: title,
        extractionMethod: "audio_note_episode",
      }),
      drefs: {
        sourceArtifact: stored.artifactId,
        recording: stored.fileEntityId,
        ...(opts.folderDid ? { isPartOf: opts.folderDid } : {}),
      },
    },
    undefined,
    { reindex: true },
  );

  return {
    mode: "audio_note",
    providerId: OIP_LOCAL_MEMORY_PROVIDER_ID,
    filename: opts.filename,
    artifactId: stored.artifactId,
    fileEntityId: stored.fileEntityId,
    episodeId: episode.id,
    created: { entities: 1, episodes: 1, assertions: 0, observations: 0, notes: 1 },
    root: stored.root,
    errors: [],
  };
}

/** Patch transcript mid-job so the Notes UI can show progress on a long rental. */
export async function updateAudioNoteProgress(opts: {
  episodeId: string;
  transcript: string;
  processingStatus?: AudioNoteProcessingStatus;
  durationSeconds?: number;
  profileId?: string;
  providerId?: string;
}): Promise<void> {
  const { provider } = providerFor(opts);
  const current = await provider.resolveRef(opts.episodeId);
  if (!current || current.type !== "Episode") return;
  const schema = { ...(current.schema ?? {}) } as Record<string, unknown>;
  schema.transcript = opts.transcript;
  if (opts.processingStatus) schema.processingStatus = opts.processingStatus;
  if (opts.durationSeconds != null) schema.durationSeconds = opts.durationSeconds;
  await provider.updateRecord(
    opts.episodeId,
    { schema },
    { reindex: false },
  );
}

export async function completeAudioNote(opts: {
  episodeId: string;
  transcript: string;
  metadata: AudioNoteMetadata;
  title?: string;
  processingStatus?: AudioNoteProcessingStatus;
  profileId?: string;
  providerId?: string;
  writeObservations?: boolean;
}): Promise<AudioNoteIngestResult> {
  const { provider, providerId, root } = providerFor(opts);
  const current = await provider.resolveRef(opts.episodeId);
  if (!current || current.type !== "Episode") {
    throw new Error(`Audio note episode not found: ${opts.episodeId}`);
  }

  const schema = (current.schema ?? {}) as Record<string, unknown>;
  const filename =
    (typeof schema.originalFilename === "string" && schema.originalFilename) ||
    (typeof current.originalFilename === "string" && current.originalFilename) ||
    current.name ||
    "recording.m4a";
  const mimeType =
    (typeof schema.encodingFormat === "string" && schema.encodingFormat) ||
    current.mimeType ||
    audioMimeFromFilename(filename);
  const artifactId = String(current.drefs?.sourceArtifact ?? current.sourceArtifact ?? "");
  const fileEntityId = String(current.drefs?.recording ?? "");
  const contentHash =
    (typeof current.provenance?.contentHash === "string" && current.provenance.contentHash) ||
    current.contentHash ||
    "";
  const title = opts.title?.trim() || current.name || filename.replace(/\.[^.]+$/, "");
  const learnedAt = new Date().toISOString();
  const processingStatus = opts.processingStatus ?? "completed";
  const durationSeconds =
    typeof schema.durationSeconds === "number" ? schema.durationSeconds : undefined;

  const updated = await provider.updateRecord(
    opts.episodeId,
    {
      name: title,
      text: opts.metadata.summary || current.text,
      schema: episodeSchema({
        title,
        metadata: opts.metadata,
        transcript: opts.transcript,
        processingStatus,
        filename,
        mimeType,
        durationSeconds,
      }),
      alfred: {
        ...(current.alfred ?? {}),
        entityClass: opts.metadata.template,
        visibility: "private",
        confidence: 1,
      },
      provenance: {
        ...(current.provenance ?? {}),
        sourceType: "audio_note",
        noteName: title,
        learnedAt,
        extractionMethod: "audio_note_episode",
      },
    },
    { reindex: false },
  );

  let observations = 0;
  if (opts.writeObservations !== false && processingStatus === "completed" && artifactId) {
    observations = await writeObservations(provider, {
      title,
      filename,
      contentHash,
      learnedAt,
      metadata: opts.metadata,
      transcript: opts.transcript,
      artifactId,
      episodeId: updated.id,
    });
  }
  await provider.rebuildIndexes();

  return {
    mode: "audio_note",
    providerId,
    filename,
    artifactId,
    fileEntityId,
    episodeId: updated.id,
    created: { entities: 0, episodes: 0, assertions: 0, observations, notes: 1 },
    root,
    errors: [],
  };
}

/**
 * Full sync ingest: store the recording, create the Episode, and write
 * summary / takeaway / action / transcript Observations.
 */
export async function ingestAudioNote(opts: {
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  title?: string;
  transcript: string;
  metadata: AudioNoteMetadata;
  recordedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  profileId?: string;
  providerId?: string;
}): Promise<AudioNoteIngestResult> {
  const started = await beginAudioNote({
    filename: opts.filename,
    bytes: opts.bytes,
    mimeType: opts.mimeType,
    title: opts.title?.trim() || opts.metadata.summary.slice(0, 80) || undefined,
    template: opts.metadata.template,
    attendees: opts.metadata.attendees,
    recordedAt: opts.recordedAt,
    durationSeconds: opts.durationSeconds,
    profileId: opts.profileId,
    providerId: opts.providerId,
  });

  return completeAudioNote({
    episodeId: started.episodeId,
    transcript: opts.transcript,
    metadata: opts.metadata,
    title: opts.title?.trim() || started.filename.replace(/\.[^.]+$/, ""),
    profileId: opts.profileId,
    providerId: opts.providerId,
  }).then((done) => ({
    ...done,
    artifactId: started.artifactId,
    fileEntityId: started.fileEntityId,
    created: {
      entities: started.created.entities,
      episodes: started.created.episodes,
      assertions: 0,
      observations: done.created.observations,
      notes: 1,
    },
  }));
}

export function isAudioNoteEpisode(rev: MemoryRevision | null | undefined): rev is MemoryRevision {
  if (!rev || rev.type !== "Episode") return false;
  if (rev.provenance?.sourceType === "audio_note") return true;
  const schema = rev.schema ?? {};
  return schema["@type"] === "Event" && typeof schema.transcript === "string" && schema.processingStatus != null;
}

export function audioNoteFromEpisode(rev: MemoryRevision): {
  id: string;
  title: string;
  template: AudioNoteTemplate;
  processingStatus: AudioNoteProcessingStatus;
  summary: string;
  takeaways: string[];
  nextSteps: AudioNoteActionItem[];
  openQuestions: string[];
  attendees: string[];
  location: string | null;
  transcript: string;
  artifactId: string | null;
  fileEntityId: string | null;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  filename: string | null;
} {
  const schema = (rev.schema ?? {}) as Record<string, unknown>;
  const templateRaw = typeof schema.template === "string" ? schema.template : "freeform";
  const template = (AUDIO_NOTE_TEMPLATES as readonly string[]).includes(templateRaw)
    ? (templateRaw as AudioNoteTemplate)
    : "freeform";
  const statusRaw = typeof schema.processingStatus === "string" ? schema.processingStatus : "completed";
  const processingStatus: AudioNoteProcessingStatus =
    statusRaw === "processing" || statusRaw === "failed" ? statusRaw : "completed";

  const nextSteps = Array.isArray(schema.nextSteps)
    ? schema.nextSteps
        .map((step) => {
          if (typeof step === "string") return { text: step };
          if (step && typeof step === "object") {
            const s = step as Record<string, unknown>;
            return {
              text: String(s.text || s.task || s.action || ""),
              assignee: s.assignee ? String(s.assignee) : undefined,
              dueDate: s.dueDate ? String(s.dueDate) : undefined,
            };
          }
          return { text: "" };
        })
        .filter((s) => s.text.trim())
    : [];

  return {
    id: rev.id,
    title: rev.name || (typeof schema.name === "string" ? schema.name : "Audio note"),
    template,
    processingStatus,
    summary: (typeof schema.description === "string" && schema.description) || rev.text || "",
    takeaways: Array.isArray(schema.takeaways) ? schema.takeaways.map((t) => String(t)) : [],
    nextSteps,
    openQuestions: Array.isArray(schema.openQuestions)
      ? schema.openQuestions.map((q) => String(q))
      : [],
    attendees: Array.isArray(schema.attendees) ? schema.attendees.map((a) => String(a)) : [],
    location: typeof schema.location === "string" && schema.location.trim() ? schema.location.trim() : null,
    transcript: typeof schema.transcript === "string" ? schema.transcript : "",
    artifactId: firstRef(rev.drefs?.sourceArtifact) ?? firstRef(rev.sourceArtifact),
    fileEntityId: firstRef(rev.drefs?.recording),
    durationSeconds: typeof schema.durationSeconds === "number" ? schema.durationSeconds : null,
    createdAt: rev.createdAt,
    updatedAt: rev.updatedAt,
    filename:
      (typeof schema.originalFilename === "string" && schema.originalFilename) ||
      rev.originalFilename ||
      null,
  };
}

function parseNoteDueDate(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function firstRef(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const hit = value.find((item) => typeof item === "string" && item.trim());
    return hit ? String(hit).trim() : null;
  }
  return null;
}
