import { createHash } from "node:crypto";
import type { CanonicalMemoryRecord } from "@alfred/contracts";
import { dedupeUserMd, isRedundant, normalizeForDedupe } from "./dedupe-user-md.js";
import { USER_MD_MAX_CHARS } from "./persona.js";

export interface CleanupUserMdOptions {
  /** Soft target for always-on USER.md size (default ~75% of inject budget). */
  targetChars?: number;
  /** Hard ceiling; content beyond this is forced into overflow. */
  maxChars?: number;
  sourceLabel?: string;
}

export interface CleanupUserMdResult {
  text: string;
  beforeChars: number;
  afterChars: number;
  overflowNotes: CanonicalMemoryRecord[];
  droppedJunk: number;
  notes: string[];
}

const INGEST_BLOCK_RE =
  /<!--\s*alfred:ingest-export:([^:]+):start\s*-->([\s\S]*?)<!--\s*alfred:ingest-export:\1:end\s*-->/gi;
const LEGACY_INGEST_RE =
  /<!--\s*alfred:ingest-export:start\s*-->([\s\S]*?)<!--\s*alfred:ingest-export:end\s*-->/gi;

const JUNK_LINE =
  /(\[\d{1,2}\/\d{1,2}\/\d{2,4}[^\]]*\]\s*Alfred:)|(password\s*[:=]\s*\S+)|(assistant turn failed)|(wave choreography finalized)|(pca9685 board arrived)|(board confirmed fried)|(akashml model list updated)|(daily backup verified)|(events refresh logged)/i;

/**
 * Rebuild USER.md into a compact always-on profile.
 * - Strips chat-log / ephemeral junk
 * - Collapses multiple ingest blocks
 * - Keeps identity + operating rules + compressed persistent context
 * - Parks remaining detail as overflow memory notes
 */
export function cleanupUserMd(
  markdown: string,
  opts: CleanupUserMdOptions = {},
): CleanupUserMdResult {
  const targetChars = opts.targetChars ?? Math.floor(USER_MD_MAX_CHARS * 0.75);
  const maxChars = opts.maxChars ?? Math.floor(USER_MD_MAX_CHARS * 0.92);
  const now = new Date().toISOString();
  const notes: string[] = [];
  let droppedJunk = 0;

  const { base, ingestBodies } = splitUserMd(markdown);
  const cleanedBase = keepBaseSkeleton(base);

  const pool = ingestBodies.join("\n\n");
  const highPriority = extractAllSections(pool, /high[- ]?priority persistent context/i).join(
    "\n\n",
  );
  const howToWork = extractAllSections(pool, /how to work effectively with me/i).join("\n\n");
  const negative = extractAllSections(
    pool,
    /negative preferences|things i dislike|dislikes/i,
  ).join("\n\n");

  const allText = `${base}\n\n${pool}`;

  const identityBullets = extractIdentityBullets(cleanedBase, allText);
  const workBullets = uniqueBullets(
    [
      ...bulletsFrom(howToWork),
      ...bulletsFrom(negative),
      ...extractWorkRulesFromProse(howToWork || pool),
      ...tableDislikesToBullets(negative || pool),
    ],
    36,
  );
  const corrections = extractCorrections(allText);
  const compressedPriority = compressHighPriority(highPriority || pool, {
    maxBullets: 22,
    onJunk: () => {
      droppedJunk += 1;
    },
  });

  const overflowNotes = buildOverflowNotes({
    pool,
    keptNorms: [
      ...identityBullets,
      ...workBullets,
      ...corrections,
      ...compressedPriority,
    ].map((b) => normalizeForDedupe(b)),
    sourceLabel: opts.sourceLabel ?? "user-cleanup",
    now,
  });

  let text = renderCleanUserMd({
    cleanedBase,
    identityBullets,
    compressedPriority,
    workBullets,
    corrections,
  });

  text = dedupeUserMd(text).text;

  while (text.length > targetChars && compressedPriority.length > 8) {
    const moved = compressedPriority.pop()!;
    overflowNotes.push(
      noteRecord(`note:user_overflow:trimmed:${slug(moved).slice(0, 32)}`, moved, now, opts.sourceLabel),
    );
    text = renderCleanUserMd({
      cleanedBase,
      identityBullets,
      compressedPriority,
      workBullets,
      corrections,
    });
    text = dedupeUserMd(text).text;
    notes.push(`trimmed persistent bullet to overflow (${moved.slice(0, 48)}…)`);
  }

  while (text.length > maxChars && workBullets.length > 10) {
    const moved = workBullets.pop()!;
    overflowNotes.push(
      noteRecord(`note:user_overflow:work:${slug(moved).slice(0, 32)}`, moved, now, opts.sourceLabel),
    );
    text = renderCleanUserMd({
      cleanedBase,
      identityBullets,
      compressedPriority,
      workBullets,
      corrections,
    });
    notes.push("trimmed work rule to overflow");
  }

  if (text.length > maxChars) {
    text =
      text.slice(0, maxChars - 80).trimEnd() +
      "\n\n<!-- alfred:cleanup truncated to inject budget; see memory notes for overflow -->\n";
    notes.push(`hard-truncated to ${maxChars} chars`);
  }

  if (text.length <= USER_MD_MAX_CHARS) {
    notes.push(`fits inject budget (${USER_MD_MAX_CHARS} chars)`);
  } else {
    notes.push(`WARNING: still over inject budget (${text.length} > ${USER_MD_MAX_CHARS})`);
  }

  return {
    text: text.endsWith("\n") ? text : `${text}\n`,
    beforeChars: markdown.length,
    afterChars: text.length,
    overflowNotes,
    droppedJunk,
    notes,
  };
}

function splitUserMd(markdown: string): { base: string; ingestBodies: string[] } {
  const ingestBodies: string[] = [];
  let rest = markdown;

  rest = rest.replace(INGEST_BLOCK_RE, (_m, _tag, body: string) => {
    ingestBodies.push(body.trim());
    return "\n";
  });
  rest = rest.replace(LEGACY_INGEST_RE, (_m, body: string) => {
    ingestBodies.push(body.trim());
    return "\n";
  });

  return { base: rest.trim(), ingestBodies };
}

function keepBaseSkeleton(base: string): string {
  const lines = base.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^context will grow/i.test(line.trim())) break;
    if (JUNK_LINE.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim().replace(/\n---\s*$/, "").trim();
}

/** Collect every matching ## section body (ingest dumps often repeat titles). */
function extractAllSections(text: string, titleRe: RegExp): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: string[] = [];
  let capturing = false;
  let body: string[] = [];
  const flush = () => {
    const t = body.join("\n").trim();
    if (t) sections.push(t);
    body = [];
    capturing = false;
  };
  for (const line of lines) {
    const hm = /^(#{1,3})\s+(.+)$/.exec(line);
    if (hm) {
      if (capturing) flush();
      if (titleRe.test(hm[2]!)) {
        capturing = true;
        continue;
      }
      continue;
    }
    if (capturing) body.push(line);
  }
  if (capturing) flush();
  return sections;
}

function bulletsFrom(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (JUNK_LINE.test(line)) continue;
    const m = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/.exec(line);
    if (m?.[1]) {
      const b = cleanBullet(m[1]);
      if (b) out.push(b);
    }
  }
  for (const block of text.split(/\n{2,}/)) {
    const t = block.trim();
    if (!t || t.length < 20) continue;
    if (JUNK_LINE.test(t)) continue;
    if (/^\|/.test(t)) continue;
    const label = /^\*\*([^*]+):\*\*\s*([\s\S]+)$/.exec(t);
    if (label) {
      out.push(cleanBullet(`${label[1]}: ${label[2]}`));
    }
  }
  return out.filter(Boolean);
}

function tableDislikesToBullets(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (JUNK_LINE.test(line)) continue;
    if (!/^\|/.test(line) || /^\|\s*-+/.test(line)) continue;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length < 2) continue;
    if (/^dislikes$/i.test(cells[0]!) || /^prefers/i.test(cells[1]!)) continue;
    out.push(`Dislikes "${cells[0]}"; prefers: ${cells[1]}`);
  }
  return out;
}

function extractWorkRulesFromProse(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (JUNK_LINE.test(line)) continue;
    const m = /^\s*[•*-]\s+(.+)$/.exec(line);
    if (m?.[1]) out.push(cleanBullet(m[1]));
  }
  return out;
}

function extractIdentityBullets(base: string, allText: string): string[] {
  const bullets: string[] = [];
  for (const line of base.split("\n")) {
    const m = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (m?.[1] && !JUNK_LINE.test(m[1])) bullets.push(cleanBullet(m[1]));
  }
  if (bullets.length >= 6) return uniqueBullets(bullets, 20);

  if (/\bDevon James\b/.test(allText)) {
    bullets.push("Name: Devon James (Mr James formal / Devon casual); he/him");
  }
  if (/America\/Los_Angeles|PST\/PDT/i.test(allText)) {
    bullets.push("Timezone: America/Los_Angeles");
  }
  if (/@DevonOfAlexandria/i.test(allText)) {
    bullets.push("Telegram: @DevonOfAlexandria");
  }
  if (/\bAmy James\b/i.test(allText)) {
    bullets.push("Wife: Amy James (Mrs James formal / Amy casual)");
  }
  if (/\bMatty\b/i.test(allText)) {
    bullets.push("Son: Matty (firstborn), born February 12, 2023");
  }
  if (/Mike and Carol/i.test(allText)) {
    bullets.push("Amy's parents: Mike and Carol");
  }
  if (/Marine/i.test(allText)) {
    bullets.push("Background: U.S. Marine Corps; software developer / solopreneur");
  }
  if (/JF Customs|JF Custom/i.test(allText)) {
    bullets.push(
      "Business: JF Customs — James Family Custom Computer Workstations and other Thinking Machines",
    );
  }
  return uniqueBullets(bullets, 20);
}

function extractCorrections(text: string): string[] {
  const out: string[] = [];
  const block = text.match(
    /\*\*Corrections that must persist:\*\*\s*([\s\S]+?)(?=\n## |\n\*\*[A-Z]|$)/i,
  );
  if (block?.[1]) {
    for (const part of block[1].split(/;\s+/)) {
      const c = cleanBullet(part);
      if (c.length > 12) out.push(c);
    }
  }
  if (/web3.*lowercase|always lowercase `?web3`?/i.test(text)) {
    out.push("Always write web3 lowercase except sentence start or proper noun Web3 Working Group");
  }
  if (/OPM is hiring agency/i.test(text)) {
    out.push("OPM is the hiring agency for the USPTO role — not the employer/position itself");
  }
  if (/Web3WG ended in 2024|Web3 Working Group.*2022.?2024/i.test(text)) {
    out.push("Web3 Working Group ended in 2024 (not ongoing)");
  }
  if (/do not (structurally )?alter|do not alter Alfred body structure/i.test(text)) {
    out.push(
      "Do not structurally alter Alfred 3D-printed body when only color/material edits were requested",
    );
  }
  return uniqueBullets(out, 12);
}

function compressHighPriority(
  text: string,
  opts: { maxBullets: number; onJunk: () => void },
): string[] {
  const candidates: string[] = [];

  for (const block of text.split(/\n{2,}/)) {
    // Redact/drop junk inside a block; don't discard a whole project for one bad line
    const lines = block.split("\n").flatMap((line) => {
      if (!JUNK_LINE.test(line)) return [line];
      opts.onJunk();
      // Chat-log / table pollution → drop; credential lines → redact & keep
      if (/password\s*[:=]/i.test(line) && !/\[\d{1,2}\/\d{1,2}\//.test(line)) {
        return [line.replace(/password\s*[:=]\s*\S+/gi, "password: [omitted]")];
      }
      return [];
    });
    const t = lines.join("\n").trim();
    if (!t) continue;
    if (/^\|/.test(t)) {
      opts.onJunk();
      continue;
    }
    if (/operational instructions|communication style:/i.test(t)) continue;

    const label = /^\*\*([^*]+):\*\*\s*([\s\S]+)$/.exec(t);
    if (label) {
      const summary = summarizeProse(label[2]!, 280);
      candidates.push(`${label[1]!.trim()}: ${summary}`);
      continue;
    }

    if (/^\d+\.\s+/.test(t.split("\n")[0] ?? "")) {
      for (const line of t.split("\n")) {
        const n = /^\d+\.\s+(.+)$/.exec(line);
        if (n) candidates.push(summarizeProse(n[1]!, 220));
      }
      continue;
    }

    if (t.length > 40 && t.length < 900 && !/^#{1,3}\s/.test(t)) {
      candidates.push(summarizeProse(t, 260));
    }
  }

  // Prefer durable topic lines; demote pure vendor laundry lists
  const ranked = candidates.sort((a, b) => scorePriorityBullet(b) - scorePriorityBullet(a));
  return uniqueBullets(ranked, opts.maxBullets);
}

function scorePriorityBullet(b: string): number {
  let s = 0;
  if (/family|federal|uspto|career|alfred:?home|robot|writing|research|web3|slobots|rock hoppers/i.test(b))
    s += 5;
  if (/model providers?:|venice|akashml/i.test(b)) s -= 3;
  if (/password|credential omitted/i.test(b)) s -= 2;
  if (b.length > 200) s -= 1;
  return s;
}

function summarizeProse(text: string, max: number): string {
  let s = text
    .replace(/\s+/g, " ")
    .replace(/password\s*[:=]\s*\S+/gi, "[credential omitted]")
    .trim();
  s = s.replace(/\(https?:\/\/[^)]+\)/gi, "");
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(". ", max - 1);
  if (cut > max * 0.5) return s.slice(0, cut + 1);
  return `${s.slice(0, max - 1).trim()}…`;
}

function buildOverflowNotes(opts: {
  pool: string;
  keptNorms: string[];
  sourceLabel?: string;
  now: string;
}): CanonicalMemoryRecord[] {
  const records: CanonicalMemoryRecord[] = [];
  const units = bulletsFrom(opts.pool);

  for (const block of opts.pool.split(/\n{2,}/)) {
    const t = block.trim();
    if (t.length < 80 || t.length > 1200) continue;
    if (JUNK_LINE.test(t) || /^\|/.test(t) || /^#{1,3}\s/.test(t)) continue;
    if (/password\s*[:=]/i.test(t)) continue;
    units.push(cleanBullet(t));
  }

  let i = 0;
  for (const u of uniqueBullets(units, 200)) {
    const norm = normalizeForDedupe(u);
    if (opts.keptNorms.some((k) => isRedundant(k, norm))) continue;
    if (
      !/(port|servo|i2c|bom|price|\$|repo|tailscale|raspberry|pca9685|beacon|kickstarter|model provider|gpio|hardware|ssh|intelligence box)/i.test(
        u,
      ) &&
      u.length < 100
    ) {
      continue;
    }
    i += 1;
    records.push(noteRecord(`note:user_overflow:${i}`, u, opts.now, opts.sourceLabel));
  }
  return records;
}

function renderCleanUserMd(parts: {
  cleanedBase: string;
  identityBullets: string[];
  compressedPriority: string[];
  workBullets: string[];
  corrections: string[];
}): string {
  const lines: string[] = [];

  if (parts.cleanedBase && parts.cleanedBase.length > 80) {
    lines.push(parts.cleanedBase, "");
  } else {
    lines.push(
      "# USER.md - About Your Human(s)",
      "",
      "## People & basics",
      ...parts.identityBullets.map((b) => `- ${b}`),
      "",
    );
  }

  lines.push(
    "_Compact always-on profile. Ephemeral detail & hardware minutiae live in long-term memory._",
    "",
    "## Persistent context",
    ...parts.compressedPriority.map((b) => `- ${b}`),
    "",
    "## How to work with Devon",
    ...parts.workBullets.map((b) => `- ${b}`),
  );

  if (parts.corrections.length) {
    lines.push("", "## Corrections that must persist", ...parts.corrections.map((b) => `- ${b}`));
  }

  lines.push(
    "",
    "<!-- alfred:ingest-export:cleaned:start -->",
    "<!-- generated by: pnpm memory -- cleanup-user -->",
    "<!-- alfred:ingest-export:cleaned:end -->",
    "",
  );
  return lines.join("\n");
}

function uniqueBullets(items: string[], limit: number): string[] {
  const out: string[] = [];
  const norms: string[] = [];
  for (const raw of items) {
    const b = cleanBullet(raw);
    if (!b || b.length < 8) continue;
    const n = normalizeForDedupe(b);
    if (!n) continue;
    if (norms.some((prev) => isRedundant(prev, n))) continue;
    norms.push(n);
    out.push(b);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanBullet(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/^[-*+•]\s+/, "")
    .replace(/\*\*/g, "")
    .trim()
    .replace(/\.$/, "");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function noteRecord(
  sourceId: string,
  content: string,
  now: string,
  sourceLabel?: string,
): CanonicalMemoryRecord {
  const body = content.endsWith(".") ? content : `${content}.`;
  const id = `mem_cleanup_${createHash("sha256").update(`${sourceId}\n${body}`).digest("hex").slice(0, 16)}`;
  return {
    id,
    content: body,
    createdAt: now,
    metadata: {
      kind: "note",
      sourceId,
      providerId: "memory.local",
      exportSource: sourceLabel ?? "user-cleanup",
    },
  };
}
