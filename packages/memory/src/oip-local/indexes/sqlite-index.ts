import { mkdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { collectDrefs } from "../dref.js";
import { displayLabel } from "../schema-org.js";
import type { MemoryRevision } from "../schemas.js";
import type { PackageStore } from "../package-store.js";
import type { ArtifactStore } from "../artifact-store.js";

export const SQLITE_DB_NAME = "alfred-memory.sqlite";

/** Minimal surface we use from node:sqlite DatabaseSync. */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

type DatabaseSyncCtor = new (path: string) => SqliteDatabase;

const nodeRequire = createRequire(import.meta.url);
let DatabaseSyncClass: DatabaseSyncCtor | null = null;

function loadDatabaseSync(): DatabaseSyncCtor {
  if (DatabaseSyncClass) return DatabaseSyncClass;
  // createRequire avoids Vitest/Vite rewriting a static `node:sqlite` import.
  const mod = nodeRequire("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };
  DatabaseSyncClass = mod.DatabaseSync;
  return DatabaseSyncClass;
}

export class SqliteMemoryIndex {
  private db: SqliteDatabase | null = null;

  constructor(readonly rootDir: string) {}

  get dbPath(): string {
    return path.join(this.rootDir, "indexes", SQLITE_DB_NAME);
  }

  open(): SqliteDatabase {
    if (this.db) return this.db;
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.ensureSchema();
    return this.db;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureSchema(): void {
    const db = this.db!;
    db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        logical_id TEXT NOT NULL,
        current_revision TEXT NOT NULL,
        record_type TEXT NOT NULL,
        schema_type TEXT,
        name TEXT,
        owner_id TEXT,
        visibility TEXT,
        created_at TEXT,
        updated_at TEXT,
        learned_at TEXT,
        search_text TEXT
      );

      CREATE TABLE IF NOT EXISTS revisions (
        record_id TEXT NOT NULL,
        revision_hash TEXT NOT NULL,
        previous_revision TEXT,
        canonical_path TEXT NOT NULL,
        created_at TEXT,
        PRIMARY KEY (record_id, revision_hash)
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        target_id TEXT NOT NULL,
        source_revision TEXT,
        PRIMARY KEY (source_id, predicate, target_id, source_revision)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        hash TEXT PRIMARY KEY,
        mime_type TEXT,
        byte_size INTEGER,
        stored_path TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS temporal (
        record_id TEXT PRIMARY KEY,
        valid_from TEXT,
        valid_until TEXT,
        learned_at TEXT,
        event_start TEXT,
        event_end TEXT
      );

      CREATE TABLE IF NOT EXISTS reminders (
        record_id TEXT PRIMARY KEY,
        remind_at TEXT,
        remind_at_sort_key TEXT,
        reminder_status TEXT,
        reminder_reason TEXT,
        reminder_timezone TEXT,
        reminder_snoozed_until TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_records_type ON records(record_type);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_pred ON edges(predicate);
    `);

    // FTS5 — recreate-safe via separate helper
    const ftsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records_fts'")
      .get();
    if (!ftsExists) {
      db.exec(`
        CREATE VIRTUAL TABLE records_fts USING fts5(
          record_id UNINDEXED,
          name,
          search_text,
          record_type UNINDEXED
        );
      `);
    }
  }

  async deleteDatabase(): Promise<void> {
    this.close();
    await rm(this.dbPath, { force: true });
    await rm(`${this.dbPath}-wal`, { force: true });
    await rm(`${this.dbPath}-shm`, { force: true });
  }

  async rebuild(packages: PackageStore, _artifacts: ArtifactStore): Promise<void> {
    await mkdir(path.join(this.rootDir, "indexes"), { recursive: true });
    await this.deleteDatabase();
    const db = this.open();

    const insertRecord = db.prepare(`
      INSERT INTO records (
        id, logical_id, current_revision, record_type, schema_type, name,
        owner_id, visibility, created_at, updated_at, learned_at, search_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRev = db.prepare(`
      INSERT INTO revisions (record_id, revision_hash, previous_revision, canonical_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges (source_id, predicate, target_id, source_revision)
      VALUES (?, ?, ?, ?)
    `);
    const insertTemporal = db.prepare(`
      INSERT INTO temporal (record_id, valid_from, valid_until, learned_at, event_start, event_end)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertReminder = db.prepare(`
      INSERT INTO reminders (
        record_id, remind_at, remind_at_sort_key, reminder_status,
        reminder_reason, reminder_timezone, reminder_snoozed_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertArtifact = db.prepare(`
      INSERT OR IGNORE INTO artifacts (hash, mime_type, byte_size, stored_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO records_fts (record_id, name, search_text, record_type)
      VALUES (?, ?, ?, ?)
    `);

    for (const logicalId of await packages.listLogicalIds()) {
      const manifest = await packages.readManifest(logicalId);
      if (!manifest) continue;
      const current = await packages.readCurrent(logicalId);
      if (!current) continue;

      const name = displayLabel(current);
      const searchText = buildSearchText(current);
      const logicalOnly = logicalId;

      insertRecord.run(
        current.id,
        logicalOnly,
        current.revision,
        current.type,
        current.schemaType ?? null,
        name,
        current.alfred?.owner ?? null,
        current.alfred?.visibility ?? "private",
        current.createdAt,
        current.updatedAt,
        current.learnedAt ?? null,
        searchText,
      );

      insertFts.run(current.id, name, searchText, current.type);

      for (const revHash of await packages.listRevisions(logicalId)) {
        const rev = await packages.readRevision(logicalId, revHash);
        if (!rev) continue;
        insertRev.run(
          current.id,
          rev.revision,
          rev.previousRevision,
          packages.revisionPath(logicalId, revHash),
          rev.updatedAt ?? rev.createdAt,
        );
      }

      for (const edge of collectDrefs(current)) {
        // Store target as logical did (strip revision fragment for graph hops)
        const targetId = edge.target.split("#")[0]!;
        insertEdge.run(current.id, edge.predicate, targetId, current.revision);
      }

      insertTemporal.run(
        current.id,
        current.validFrom ?? null,
        current.validUntil ?? null,
        current.learnedAt ?? null,
        current.validTimeStart ?? null,
        current.validTimeEnd ?? null,
      );

      if (current.remindAt != null || current.reminderStatus) {
        const remindAt = current.remindAt ?? null;
        insertReminder.run(
          current.id,
          remindAt,
          remindAtSortKey(remindAt),
          current.reminderStatus ?? "pending",
          current.reminderReason ?? null,
          current.reminderTimezone ?? null,
          current.reminderSnoozedUntil ?? null,
        );
      }

      if (current.type === "Artifact" && current.contentHash) {
        insertArtifact.run(
          current.contentHash,
          current.mimeType ?? null,
          current.byteSize ?? null,
          current.storedAt ?? null,
          current.ingestedAt ?? current.createdAt,
        );
      }
    }
  }

  searchFts(query: string, limit = 20): Array<{ record_id: string; rank: number }> {
    const db = this.open();
    const match = toFtsQuery(query);
    if (!match) return [];
    try {
      const rows = db
        .prepare(
          `SELECT record_id, bm25(records_fts) AS rank
           FROM records_fts
           WHERE records_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(match, limit) as Array<{ record_id: string; rank: number }>;
      return rows;
    } catch {
      return [];
    }
  }

  getRecord(id: string): RecordRow | null {
    const db = this.open();
    return (
      (db.prepare("SELECT * FROM records WHERE id = ? OR logical_id = ?").get(id, stripDid(id)) as
        | RecordRow
        | undefined) ?? null
    );
  }

  findByName(name: string, recordType?: string): RecordRow[] {
    const db = this.open();
    if (recordType) {
      return db
        .prepare(
          `SELECT * FROM records
           WHERE record_type = ? AND (LOWER(name) = LOWER(?) OR LOWER(search_text) LIKE ?)
           LIMIT 20`,
        )
        .all(recordType, name, `%${name.toLowerCase()}%`) as RecordRow[];
    }
    return db
      .prepare(
        `SELECT * FROM records
         WHERE LOWER(name) = LOWER(?) OR LOWER(search_text) LIKE ?
         LIMIT 20`,
      )
      .all(name, `%${name.toLowerCase()}%`) as RecordRow[];
  }

  edgesFrom(sourceId: string): EdgeRow[] {
    const db = this.open();
    return db
      .prepare("SELECT * FROM edges WHERE source_id = ?")
      .all(sourceId) as EdgeRow[];
  }

  edgesTo(targetId: string): EdgeRow[] {
    const db = this.open();
    const tid = targetId.startsWith("did:memory:") ? targetId : `did:memory:${targetId}`;
    return db.prepare("SELECT * FROM edges WHERE target_id = ?").all(tid) as EdgeRow[];
  }

  listByType(recordType: string, limit = 50): RecordRow[] {
    const db = this.open();
    return db
      .prepare("SELECT * FROM records WHERE record_type = ? LIMIT ?")
      .all(recordType, limit) as RecordRow[];
  }

  findBySearchSubstring(substr: string, limit = 40): RecordRow[] {
    const db = this.open();
    const q = substr.trim();
    if (!q) return [];
    return db
      .prepare(
        `SELECT * FROM records
         WHERE LOWER(search_text) LIKE ? OR LOWER(name) LIKE ?
         LIMIT ?`,
      )
      .all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, limit) as RecordRow[];
  }

  listByLearnedAtRange(startIso: string, endIso: string, limit = 80): RecordRow[] {
    const db = this.open();
    return db
      .prepare(
        `SELECT rec.* FROM records rec
         JOIN temporal t ON t.record_id = rec.id
         WHERE t.learned_at IS NOT NULL
           AND t.learned_at >= ?
           AND t.learned_at <= ?
         LIMIT ?`,
      )
      .all(startIso, endIso, limit) as RecordRow[];
  }

  listByValidFromRange(startIso: string, endIso: string, limit = 80): RecordRow[] {
    const db = this.open();
    return db
      .prepare(
        `SELECT rec.* FROM records rec
         JOIN temporal t ON t.record_id = rec.id
         WHERE t.valid_from IS NOT NULL
           AND t.valid_from >= ?
           AND t.valid_from <= ?
         LIMIT ?`,
      )
      .all(startIso, endIso, limit) as RecordRow[];
  }

  listAllRecords(limit = 5000): RecordRow[] {
    const db = this.open();
    return db
      .prepare("SELECT * FROM records ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as RecordRow[];
  }

  listAllEdges(limit = 20_000): EdgeRow[] {
    const db = this.open();
    return db.prepare("SELECT * FROM edges LIMIT ?").all(limit) as EdgeRow[];
  }

  countRecords(): number {
    const db = this.open();
    const row = db.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number };
    return Number(row?.n ?? 0);
  }

  countEdges(): number {
    const db = this.open();
    const row = db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number };
    return Number(row?.n ?? 0);
  }

  /**
   * Due-or-overdue reminders for Daily Brief (PRD §55).
   * `windowEnd` should be a comparable ISO/date sort key (e.g. end of local briefing day).
   */
  listDue(opts: {
    windowEnd: string;
    statuses?: string[];
    limit?: number;
  }): ReminderRow[] {
    const db = this.open();
    const statuses = opts.statuses ?? ["pending", "surfaced"];
    const limit = opts.limit ?? 50;
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT r.*, rec.name AS record_name, rec.record_type, rec.logical_id
         FROM reminders r
         LEFT JOIN records rec ON rec.id = r.record_id
         WHERE r.reminder_status IN (${placeholders})
           AND r.remind_at_sort_key IS NOT NULL
           AND r.remind_at_sort_key <= ?
           AND (r.reminder_snoozed_until IS NULL OR r.reminder_snoozed_until <= ?)
         ORDER BY r.remind_at_sort_key ASC
         LIMIT ?`,
      )
      .all(...statuses, opts.windowEnd, opts.windowEnd, limit) as ReminderRow[];
    return rows;
  }
}

/** Date-only remindAt sorts as end-of-day UTC so the whole local calendar day is due. */
export function remindAtSortKey(remindAt: string | null | undefined): string | null {
  if (remindAt == null || remindAt === "") return null;
  const trimmed = remindAt.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T23:59:59.999Z`;
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return trimmed;
  return new Date(ms).toISOString();
}

export interface RecordRow {
  id: string;
  logical_id: string;
  current_revision: string;
  record_type: string;
  schema_type: string | null;
  name: string | null;
  owner_id: string | null;
  visibility: string | null;
  created_at: string | null;
  updated_at: string | null;
  learned_at: string | null;
  search_text: string | null;
}

export interface EdgeRow {
  source_id: string;
  predicate: string;
  target_id: string;
  source_revision: string | null;
}

export interface ReminderRow {
  record_id: string;
  remind_at: string | null;
  remind_at_sort_key: string | null;
  reminder_status: string | null;
  reminder_reason: string | null;
  reminder_timezone: string | null;
  reminder_snoozed_until: string | null;
  record_name?: string | null;
  record_type?: string | null;
  logical_id?: string | null;
}

function buildSearchText(r: MemoryRevision): string {
  const parts: string[] = [];
  if (r.name) parts.push(r.name);
  if (r.text) parts.push(r.text);
  if (typeof r.schema?.name === "string") parts.push(String(r.schema.name));
  if (typeof r.schema?.url === "string") parts.push(String(r.schema.url));
  if (typeof r.schema?.description === "string") parts.push(String(r.schema.description));
  if (typeof r.schema?.author === "string") parts.push(String(r.schema.author));
  if (Array.isArray(r.schema?.alternateName)) {
    parts.push(...r.schema.alternateName.map(String));
  }
  if (r.predicate) parts.push(r.predicate);
  if (r.object != null && typeof r.object !== "object") parts.push(String(r.object));
  if (r.type) parts.push(r.type);
  if (r.schemaType) parts.push(r.schemaType);
  const prov = r.provenance ?? {};
  if (typeof prov.sourceType === "string") {
    parts.push(prov.sourceType.replace(/_/g, " "));
    if (prov.sourceType === "x_com") parts.push("x.com", "twitter", "X");
    if (prov.sourceType === "youtube") parts.push("youtube", "YouTube", "video");
  }
  if (typeof prov.noteName === "string") parts.push(prov.noteName, "note");
  if (typeof prov.noteFolder === "string") parts.push(prov.noteFolder);
  if (Array.isArray(prov.noteNames)) parts.push(...prov.noteNames.map(String));
  if (typeof prov.author === "string") parts.push(prov.author);
  if (typeof prov.source === "string") parts.push(prov.source);
  return parts.join(" ");
}

function toFtsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "we",
  "had",
  "at",
  "was",
  "what",
  "who",
  "where",
  "when",
  "did",
  "does",
  "is",
  "are",
  "of",
  "to",
  "for",
  "in",
  "on",
  "and",
  "or",
]);

function stripDid(id: string): string {
  return id.startsWith("did:memory:") ? id.slice("did:memory:".length).split("#")[0]! : id;
}
