/**
 * Deduplicate redundant bullets/paragraphs in USER.md while preserving
 * structure (headings, ingest markers, hand-authored skeleton).
 */

export interface DedupeUserMdResult {
  text: string;
  beforeChars: number;
  afterChars: number;
  removedUnits: number;
  keptUnits: number;
  notes: string[];
}

type UnitKind = "marker" | "heading" | "bullet" | "paragraph" | "blank" | "other";

interface Unit {
  kind: UnitKind;
  raw: string;
  /** Normalized text used for redundancy checks (empty for structural units). */
  norm: string;
}

const MARKER_RE = /<!--\s*alfred:ingest-export:[^>]+-->/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BULLET_RE = /^\s*([-*+•]|\d+[.)])\s+(.+)$/;

/**
 * Remove near-duplicate bullets and paragraphs from a USER.md document.
 * Keeps the first occurrence; later redundant units are dropped.
 * Headings and alfred ingest markers are always preserved.
 */
export function dedupeUserMd(markdown: string): DedupeUserMdResult {
  const beforeChars = markdown.length;
  const units = parseUnits(markdown);
  const kept: Unit[] = [];
  const seenExact = new Set<string>();
  const contentNorms: string[] = [];
  let removedUnits = 0;
  const notes: string[] = [];

  for (const unit of units) {
    if (unit.kind === "marker" || unit.kind === "heading" || unit.kind === "other") {
      kept.push(unit);
      continue;
    }
    if (unit.kind === "blank") {
      // Collapse runs of blank lines to a single blank.
      if (kept.length && kept[kept.length - 1]!.kind === "blank") {
        removedUnits += 1;
        continue;
      }
      kept.push(unit);
      continue;
    }

    // bullet / paragraph
    if (!unit.norm || unit.norm.length < 12) {
      kept.push(unit);
      continue;
    }

    if (seenExact.has(unit.norm)) {
      removedUnits += 1;
      continue;
    }

    const coveredBy = contentNorms.find((prev) => isRedundant(prev, unit.norm));
    if (coveredBy) {
      removedUnits += 1;
      continue;
    }

    // If this longer unit supersedes a shorter earlier one, drop the earlier keep.
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i]!;
      if (k.kind !== "bullet" && k.kind !== "paragraph") continue;
      if (!k.norm) continue;
      if (isRedundant(unit.norm, k.norm) && unit.norm.length > k.norm.length + 20) {
        kept.splice(i, 1);
        removedUnits += 1;
        // also remove from contentNorms
        const idx = contentNorms.indexOf(k.norm);
        if (idx >= 0) contentNorms.splice(idx, 1);
        seenExact.delete(k.norm);
        notes.push(`superseded shorter unit: "${k.norm.slice(0, 60)}…"`);
      }
    }

    seenExact.add(unit.norm);
    contentNorms.push(unit.norm);
    kept.push(unit);
  }

  const text = serializeUnits(kept).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return {
    text,
    beforeChars,
    afterChars: text.length,
    removedUnits,
    keptUnits: kept.filter((u) => u.kind === "bullet" || u.kind === "paragraph").length,
    notes,
  };
}

export function parseUnits(markdown: string): Unit[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const units: Unit[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const raw = para.join("\n").trim();
    para = [];
    if (!raw) return;
    units.push({ kind: "paragraph", raw, norm: normalizeForDedupe(raw) });
  };

  for (const line of lines) {
    if (MARKER_RE.test(line.trim())) {
      flushPara();
      units.push({ kind: "marker", raw: line, norm: "" });
      continue;
    }
    if (HEADING_RE.test(line.trim())) {
      flushPara();
      units.push({ kind: "heading", raw: line, norm: "" });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      units.push({ kind: "blank", raw: "", norm: "" });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushPara();
      const content = bullet[2]!.trim();
      units.push({
        kind: "bullet",
        raw: line,
        norm: normalizeForDedupe(content),
      });
      continue;
    }
    // Table rows / misc — treat as paragraph lines (accumulate)
    para.push(line);
  }
  flushPara();
  return units;
}

function serializeUnits(units: Unit[]): string {
  return units
    .map((u) => (u.kind === "blank" ? "" : u.raw))
    .join("\n");
}

/** Normalize for comparison: casefold, strip md emphasis, collapse space. */
export function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s./@+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeForDedupe(norm: string): Set<string> {
  return new Set(
    norm
      .split(/\s+/)
      .map((t) => t.replace(/^\W+|\W+$/g, ""))
      .filter((t) => t.length > 2),
  );
}

/** True if `candidate` is redundant given already-kept `existing`. */
export function isRedundant(existing: string, candidate: string): boolean {
  if (!existing || !candidate) return false;
  if (existing === candidate) return true;

  const a = existing;
  const b = candidate;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;

  // Near-containment of a substantial phrase
  if (shorter.length >= 24 && longer.includes(shorter)) return true;

  const ta = tokenizeForDedupe(a);
  const tb = tokenizeForDedupe(b);
  if (ta.size === 0 || tb.size === 0) return false;

  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const jaccard = inter / (ta.size + tb.size - inter);
  if (jaccard >= 0.82) return true;

  // High coverage of the smaller set
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size <= tb.size ? tb : ta;
  let covered = 0;
  for (const t of smaller) if (larger.has(t)) covered += 1;
  if (smaller.size >= 5 && covered / smaller.size >= 0.9) return true;

  return false;
}
