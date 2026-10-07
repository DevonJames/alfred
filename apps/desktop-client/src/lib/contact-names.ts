import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);

interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

/** Digits for a phone, or the lowercased address for email. US numbers drop a leading 1. */
export function contactKey(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function contactPersonName(
  first: string | null,
  last: string | null,
  organization: string | null,
  nickname: string | null,
): string {
  const person = [first, last]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return person || (organization ?? "").trim() || (nickname ?? "").trim();
}

function preferName(current: string | undefined, next: string): string {
  if (!current) return next;
  const score = (name: string) => name.split(/\s+/).length * 10 + name.length;
  return score(next) > score(current) ? next : current;
}

function addressBookPaths(): string[] {
  const sources = path.join(homedir(), "Library/Application Support/AddressBook/Sources");
  try {
    return readdirSync(sources)
      .map((entry) => path.join(sources, entry, "AddressBook-v22.abcddb"))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function directoryStamp(files: string[]): string {
  return files
    .map((file) => {
      try {
        return `${file}:${statSync(file).mtimeMs}`;
      } catch {
        return file;
      }
    })
    .join("|");
}

let directory: { stamp: string; names: Map<string, string> } | null = null;

function loadDirectory(): Map<string, string> {
  const files = addressBookPaths();
  const stamp = directoryStamp(files);
  if (directory && directory.stamp === stamp) return directory.names;
  const names = new Map<string, string>();
  let DatabaseSync: DatabaseSyncCtor;
  try {
    DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
  } catch {
    directory = { stamp, names };
    return names;
  }
  const phoneSql = `SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS org,
      r.ZNICKNAME AS nick, p.ZFULLNUMBER AS value
    FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER
    WHERE p.ZFULLNUMBER IS NOT NULL`;
  const emailSql = `SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS org,
      r.ZNICKNAME AS nick, e.ZADDRESS AS value
    FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER
    WHERE e.ZADDRESS IS NOT NULL`;
  for (const file of files) {
    let db: SqliteDatabase | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      for (const sql of [phoneSql, emailSql]) {
        const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const value = typeof row.value === "string" ? row.value : "";
          const key = contactKey(value);
          if (!key || (key.includes("@") ? false : key.length < 7)) continue;
          const name = contactPersonName(
            typeof row.first === "string" ? row.first : null,
            typeof row.last === "string" ? row.last : null,
            typeof row.org === "string" ? row.org : null,
            typeof row.nick === "string" ? row.nick : null,
          );
          if (!name) continue;
          names.set(key, preferName(names.get(key), name));
        }
      }
    } catch {
      continue;
    } finally {
      db?.close();
    }
  }
  directory = { stamp, names };
  return names;
}

/** The saved contact's name, or the handle itself when nobody matches. */
export function contactLabel(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const key = contactKey(handle);
  if (!key) return handle;
  return loadDirectory().get(key) || handle;
}
