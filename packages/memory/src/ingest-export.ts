import { createHash } from "node:crypto";
import type { CanonicalMemoryRecord } from "@alfred/contracts";

/** Legacy single-block markers (still replaced when sourceLabel is omitted). */
export const INGEST_START = "<!-- alfred:ingest-export:start -->";
export const INGEST_END = "<!-- alfred:ingest-export:end -->";

export function ingestMarkers(sourceLabel?: string): { start: string; end: string } {
  if (!sourceLabel) return { start: INGEST_START, end: INGEST_END };
  const tag = slug(sourceLabel.replace(/\.[^.]+$/, "")) || "export";
  return {
    start: `<!-- alfred:ingest-export:${tag}:start -->`,
    end: `<!-- alfred:ingest-export:${tag}:end -->`,
  };
}

export interface MdSection {
  level: number;
  title: string;
  body: string;
}

export interface IngestExportResult {
  userPatch: string;
  userSectionsFound: string[];
  memoryRecords: CanonicalMemoryRecord[];
  skippedSections: string[];
  /** Markers used for this patch (source-specific when label provided). */
  markers: { start: string; end: string };
}

const USER_SECTION_MATCHERS: { key: string; pattern: RegExp }[] = [
  {
    key: "High-Priority Persistent Context",
    pattern: /^high[- ]?priority persistent context\b/i,
  },
  {
    key: "How to Work Effectively With Me",
    pattern: /^how to work effectively with me\b/i,
  },
  {
    key: "Negative Preferences",
    pattern: /^(negative preferences|things i dislike|dislikes)\b/i,
  },
];

const SKIP_SECTION_PATTERNS = [
  /^potentially stale information\b/i,
  /^knowledge gaps\b/i,
];

/**
 * Parse a knowledge-export markdown file into heading sections.
 * Top-level preamble (before first heading) is kept as level 0.
 */
export function parseMarkdownSections(markdown: string): MdSection[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: MdSection[] = [];
  let level = 0;
  let title = "(preamble)";
  let body: string[] = [];

  const flush = () => {
    const text = body.join("\n").trim();
    if (level === 0 && !text) {
      body = [];
      return;
    }
    sections.push({ level, title, body: text });
    body = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      level = m[1]!.length;
      title = m[2]!.replace(/#+$/, "").trim();
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

/**
 * Parse plain-text / OpenClaw-style numbered outlines:
 *   1. Personal and Family Context
 *   23. How to Work Effectively With Me
 * Separators like ─── are ignored.
 */
export function parseOutlineSections(text: string): MdSection[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: MdSection[] = [];
  let level = 0;
  let title = "(preamble)";
  let body: string[] = [];

  const flush = () => {
    const content = body.join("\n").trim();
    if (level === 0 && !content) {
      body = [];
      return;
    }
    sections.push({ level, title, body: content });
    body = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // Decorative rules (box-drawing or markdown hr)
    if (/^[─\-_=*]{3,}$/.test(trimmed)) continue;

    const numbered = /^(\d+)[.)]\s+(.+)$/.exec(trimmed);
    if (numbered) {
      const rest = numbered[2]!.trim();
      // Avoid treating inline numbered list items as section headers:
      // "1. Robot face design: Project registry incorrectly stated…"
      const colonIdx = rest.indexOf(": ");
      const hasLongTailAfterColon = colonIdx >= 0 && rest.length - colonIdx > 28;
      const looksLikeHeader = rest.length <= 100 && !hasLongTailAfterColon;
      if (looksLikeHeader) {
        flush();
        level = 2;
        title = rest;
        continue;
      }
    }

    body.push(line);
  }
  flush();
  return sections;
}

/** Prefer ATX markdown headings when present; otherwise numbered outline. */
export function parseExportSections(text: string): MdSection[] {
  const atx = parseMarkdownSections(text).filter((s) => s.level >= 1);
  if (atx.length >= 3) return parseMarkdownSections(text);
  const outline = parseOutlineSections(text);
  const outlineSections = outline.filter((s) => s.level >= 1);
  if (outlineSections.length > atx.length) return outline;
  return parseMarkdownSections(text);
}

function normalizeTitle(title: string): string {
  return title
    .replace(/^#+\s*/, "")
    // Strip export numbering: "37. High-Priority…" / "1.2 Family" / "34)"
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/, "")
    .trim();
}

function isUserSection(title: string): { key: string } | undefined {
  const t = normalizeTitle(title);
  for (const m of USER_SECTION_MATCHERS) {
    if (m.pattern.test(t)) return { key: m.key };
  }
  return undefined;
}

function isSkipSection(title: string): boolean {
  return SKIP_SECTION_PATTERNS.some((p) => p.test(normalizeTitle(title)));
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
}

function stableId(sourceId: string, content: string): string {
  const h = createHash("sha256").update(`${sourceId}\n${content}`).digest("hex").slice(0, 16);
  return `mem_export_${h}`;
}

/**
 * Split a knowledge-export report into:
 * - USER.md patch body (high-priority + operating guide)
 * - Canonical memory records (notes/facts) for JSONL import
 */
export function planIngestExport(
  markdown: string,
  opts?: { sourceLabel?: string },
): IngestExportResult {
  const sourceLabel = opts?.sourceLabel ?? "export";
  const sections = parseExportSections(markdown);
  const userPieces: { key: string; body: string }[] = [];
  const userSectionsFound: string[] = [];
  const skippedSections: string[] = [];
  const memoryRecords: CanonicalMemoryRecord[] = [];
  const now = new Date().toISOString();

  // Walk sections; nest ### under last ## for sourceId path
  let currentH2 = "general";

  for (const section of sections) {
    const title = normalizeTitle(section.title);
    if (section.level === 0) continue;

    if (section.level <= 2) currentH2 = slug(title) || "general";

    const userHit = isUserSection(title);
    if (userHit && section.body.trim()) {
      userPieces.push({ key: userHit.key, body: section.body.trim() });
      userSectionsFound.push(userHit.key);
      continue;
    }

    if (isSkipSection(title)) {
      skippedSections.push(title);
      continue;
    }

    // Don't duplicate user sections into memory as giant blobs.
    if (isUserSection(title)) continue;

    const records = sectionToRecords(section, currentH2, sourceLabel, now);
    memoryRecords.push(...records);
  }

  // Deterministic order; dedupe by sourceId keeping longest content
  const bySource = new Map<string, CanonicalMemoryRecord>();
  for (const r of memoryRecords) {
    const sid = String(r.metadata?.sourceId ?? r.id);
    const prev = bySource.get(sid);
    if (!prev || r.content.length > prev.content.length) bySource.set(sid, r);
  }

  const markers = ingestMarkers(sourceLabel);
  const userPatch = buildUserPatch(userPieces, markers);

  return {
    userPatch,
    userSectionsFound,
    memoryRecords: [...bySource.values()],
    skippedSections,
    markers,
  };
}

function sectionToRecords(
  section: MdSection,
  h2Slug: string,
  sourceLabel: string,
  now: string,
): CanonicalMemoryRecord[] {
  const body = section.body.trim();
  if (!body || body.length < 8) return [];

  const titleSlug = slug(section.title) || "section";
  const pathSlug = section.level >= 3 ? `${h2Slug}/${titleSlug}` : titleSlug;

  // Prefer individual bullets when the section is mostly a list.
  const bullets = extractBullets(body);
  if (bullets.length >= 2 && bullets.join("\n").length > body.length * 0.45) {
    return bullets
      .filter((b) => b.length >= 8)
      .slice(0, 120)
      .map((b, i) => {
        const sourceId = `note:export:${pathSlug}:${i + 1}`;
        const content = b.endsWith(".") ? b : `${b}.`;
        return {
          id: stableId(sourceId, content),
          content,
          createdAt: now,
          metadata: {
            kind: "note",
            sourceId,
            providerId: "memory.local",
            exportSource: sourceLabel,
            section: section.title,
          },
        } satisfies CanonicalMemoryRecord;
      });
  }

  // Otherwise one note per section (chunk if very long).
  const chunks = chunkText(body, 900);
  return chunks.map((chunk, i) => {
    const sourceId =
      chunks.length === 1 ? `note:export:${pathSlug}` : `note:export:${pathSlug}:${i + 1}`;
    const content =
      chunks.length === 1
        ? `${section.title}: ${chunk}`
        : `${section.title} (${i + 1}/${chunks.length}): ${chunk}`;
    return {
      id: stableId(sourceId, content),
      content,
      createdAt: now,
      metadata: {
        kind: "note",
        sourceId,
        providerId: "memory.local",
        exportSource: sourceLabel,
        section: section.title,
      },
    } satisfies CanonicalMemoryRecord;
  });
}

function extractBullets(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m =
      /^\s*[-*+•]\s+(.+)$/.exec(line) ??
      /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(". ", max);
    if (cut < max * 0.4) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).replace(/^\s*\.\s*/, "").trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function buildUserPatch(
  pieces: { key: string; body: string }[],
  markers: { start: string; end: string } = { start: INGEST_START, end: INGEST_END },
): string {
  if (!pieces.length) return "";
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
  // Any unexpected keys
  for (const [key, body] of byKey) {
    if (order.includes(key)) continue;
    blocks.push(`## ${key}\n\n${body}`);
  }
  return `${markers.start}\n\n${blocks.join("\n\n")}\n\n${markers.end}`;
}

/** Merge ingest patch into USER.md, replacing the matching marker block if present. */
export function mergeUserMd(
  existing: string,
  ingestPatch: string,
  markers: { start: string; end: string } = { start: INGEST_START, end: INGEST_END },
): string {
  if (!ingestPatch.trim()) return existing;
  const start = existing.indexOf(markers.start);
  const end = existing.indexOf(markers.end);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + markers.end.length).trimStart();
    return [before, ingestPatch, after].filter(Boolean).join("\n\n") + "\n";
  }
  const base = existing.trimEnd();
  return `${base}\n\n${ingestPatch}\n`;
}
