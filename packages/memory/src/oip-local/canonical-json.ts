/**
 * Deterministic JSON for content hashing.
 * - Object keys sorted lexicographically
 * - Arrays preserve order (semantic)
 * - Timestamps normalized to RFC3339 when recognized
 * - `revision` field replaced with placeholder before hashing
 */

const REVISION_PLACEHOLDER = "";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize known timestamp-looking strings to ISO/RFC3339 via Date. */
export function normalizeTimestamp(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  // Date-only YYYY-MM-DD — keep as date-only (do not invent a time).
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return trimmed;
  return new Date(ms).toISOString();
}

const TIMESTAMP_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "learnedAt",
  "observedAt",
  "ingestedAt",
  "validFrom",
  "validUntil",
  "validTimeStart",
  "validTimeEnd",
  "eventTime",
  "remindAt",
  "reminderCreatedAt",
  "reminderCompletedAt",
  "reminderLastSurfacedAt",
  "reminderSnoozedUntil",
]);

function canonicalizeValue(value: unknown, key?: string): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (key && TIMESTAMP_KEYS.has(key)) return normalizeTimestamp(value);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeValue(v));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      if (k === "revision") {
        out[k] = REVISION_PLACEHOLDER;
        continue;
      }
      out[k] = canonicalizeValue(value[k], k);
    }
    return out;
  }
  return value;
}

/** Canonical JSON string (no trailing newline). */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJsonString(value), "utf8");
}
