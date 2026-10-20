import { parseMemoryRef } from "../oip-local/ids.js";
import type { OipLocalMemoryProvider } from "../oip-local/provider.js";
import { SCHEMA_ORG } from "../oip-local/schema-org.js";
import type { MemoryRevision } from "../oip-local/schemas.js";
import { hashBytes } from "../oip-local/hashing.js";
import { loadXLedger } from "./ledger.js";
import { setXSourceBriefDid } from "./sources.js";
import type { XIngestItemResult, XLedgerEntry, XSource } from "./types.js";
import { slugFromTitle } from "./urls.js";

export const NOTE_BRIEF_ENTITY_CLASS = "notes_inbox_brief";

export interface NoteBriefCatalogItem {
  url: string;
  canonicalUrl: string;
  status: string;
  kind?: string;
  headline?: string;
  author?: string;
  summary?: string;
  error?: string;
  detail?: string;
  newlyIngested?: boolean;
}

export interface NoteBriefDraft {
  folder: string;
  note: string;
  archiveNote: string;
  remainingNoteText: string;
  previousMarkdown?: string;
  items: NoteBriefCatalogItem[];
  scannedAt: string;
}

export type NoteBriefWriter = (draft: NoteBriefDraft) => Promise<string>;

export interface NoteBriefWriteResult {
  did: string;
  artifactDid: string;
  markdown: string;
  updated: boolean;
  revision: string;
}

const DETAIL_LIMIT = 1200;
const CATALOG_LIMIT = 120;

export function plainNoteText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fallbackNoteBriefMarkdown(draft: NoteBriefDraft): string {
  const saved = draft.items.filter((i) => i.status === "ingested");
  const failed = draft.items.filter((i) => i.status === "failed");
  const lines: string[] = [
    `# ${draft.note}`,
    "",
    `Apple Notes inbox **${draft.note}** in folder **${draft.folder}**. Archive: **${draft.archiveNote}**. Updated ${draft.scannedAt.slice(0, 10)}.`,
    "",
  ];
  if (draft.remainingNoteText) {
    lines.push("## Personal notes still in the inbox", "", draft.remainingNoteText, "");
  }
  if (draft.previousMarkdown && /## What this note is about/i.test(draft.previousMarkdown)) {
    const overview = extractSection(draft.previousMarkdown, "What this note is about");
    if (overview) {
      lines.push("## What this note is about", "", overview, "");
    }
  } else {
    const authors = [...new Set(saved.map((i) => i.author).filter(Boolean))];
    const kinds = [...new Set(saved.map((i) => i.kind).filter(Boolean))];
    lines.push(
      "## What this note is about",
      "",
      saved.length
        ? `This inbox collects ${kinds.join(", ") || "saved links"} (${saved.length} ingested). ${
            authors.length ? `Sources include ${authors.slice(0, 12).join(", ")}.` : ""
          }`
        : "No links have been ingested from this note yet.",
      "",
    );
  }
  if (saved.length) {
    lines.push("## Saved items", "");
    for (const item of saved) {
      const title = [item.author, item.headline || item.canonicalUrl].filter(Boolean).join(" — ");
      lines.push(`### ${title}`);
      if (item.kind) lines.push(`- Kind: ${item.kind}`);
      lines.push(`- ${item.canonicalUrl || item.url}`);
      if (item.summary) lines.push("", item.summary, "");
      else if (item.detail) lines.push("", item.detail.slice(0, DETAIL_LIMIT), "");
      else lines.push("");
    }
  }
  if (failed.length) {
    lines.push("## Could not ingest", "");
    for (const item of failed) {
      lines.push(`- ${item.headline || item.url}${item.error ? ` (${item.error})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function extractSection(markdown: string, heading: string): string | undefined {
  const re = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "i");
  const m = markdown.match(re);
  const body = m?.[1]?.trim();
  return body || undefined;
}

async function llmNoteBriefMarkdown(draft: NoteBriefDraft, apiKey: string): Promise<string | undefined> {
  const model = process.env.OPENAI_NOTE_BRIEF_MODEL?.trim() || process.env.OPENAI_DOCS_EXTRACT_MODEL?.trim() || "gpt-5.6-terra";
  const catalog = draft.items.slice(0, CATALOG_LIMIT).map((item) => ({
    author: item.author,
    headline: item.headline,
    kind: item.kind,
    status: item.status,
    url: item.canonicalUrl || item.url,
    summary: item.summary || item.detail?.slice(0, 500),
    error: item.error,
    new: item.newlyIngested || false,
  }));
  const user = `Rewrite the briefing document for Apple Note "${draft.note}" (folder "${draft.folder}", archive "${draft.archiveNote}").
The document must describe what the note is about and include every important detail from the current inventory.
Keep still-accurate material from the previous document. Add new items. Drop or correct anything that no longer matches the inventory.
Return Markdown only, starting with "# ${draft.note}".

Previous document:
${draft.previousMarkdown?.trim() || "(none)"}

Personal text still in the inbox:
${draft.remainingNoteText || "(none)"}

Current inventory (JSON):
${JSON.stringify({ scannedAt: draft.scannedAt, items: catalog }, null, 2)}
`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You maintain a durable briefing document for an Apple Notes ingest inbox. State only facts present in the inventory or previous document. Do not invent links, quotes, or claims.",
        },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  return text || undefined;
}

export async function defaultNoteBriefWriter(draft: NoteBriefDraft): Promise<string> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key) {
    try {
      const llm = await llmNoteBriefMarkdown(draft, key);
      if (llm) return llm.endsWith("\n") ? llm : `${llm}\n`;
    } catch {
      /* fall through */
    }
  }
  return fallbackNoteBriefMarkdown(draft);
}

async function readRevisionText(
  provider: OipLocalMemoryProvider,
  did?: string,
): Promise<{ rev: MemoryRevision; text: string } | undefined> {
  if (!did) return undefined;
  try {
    const ref = did.startsWith("did:memory:") ? did : `did:memory:${did}`;
    const logicalId = parseMemoryRef(ref).logicalId;
    const rev = await provider.packages.readCurrent(logicalId);
    if (!rev) return undefined;
    return { rev, text: (rev.text ?? "").trim() };
  } catch {
    return undefined;
  }
}

async function findExistingBrief(
  provider: OipLocalMemoryProvider,
  source: XSource,
): Promise<MemoryRevision | undefined> {
  if (source.briefDid) {
    const hit = await readRevisionText(provider, source.briefDid);
    if (hit?.rev) return hit.rev;
  }
  const named = provider.sqlite.findByName(source.note, "Entity");
  for (const row of named) {
    const rev = await provider.packages.readCurrent(row.logical_id);
    if (rev?.alfred?.entityClass === NOTE_BRIEF_ENTITY_CLASS) return rev;
  }
  return undefined;
}

async function detailForEntry(
  provider: OipLocalMemoryProvider,
  entry: XLedgerEntry,
): Promise<string | undefined> {
  if (!entry.memoryDid) return undefined;
  const hit = await readRevisionText(provider, entry.memoryDid);
  if (!hit?.text) return undefined;
  return hit.text.slice(0, DETAIL_LIMIT);
}

function provenance(source: XSource, learnedAt: string, extra?: Record<string, unknown>) {
  return {
    sourceType: "x_notes_ingest",
    extractionMethod: "notes_inbox_brief",
    noteName: source.note,
    noteFolder: source.folder,
    noteNames: [source.note],
    noteFolders: [source.folder],
    learnedAt,
    ...extra,
  };
}

export async function writeNoteInboxBrief(opts: {
  provider: OipLocalMemoryProvider;
  profileId: string;
  source: XSource;
  remainingBody: string;
  processed: XIngestItemResult[];
  now?: Date;
  writer?: NoteBriefWriter;
}): Promise<NoteBriefWriteResult | undefined> {
  const now = opts.now ?? new Date();
  const learnedAt = now.toISOString();
  const ledger = await loadXLedger(opts.profileId);
  const noteKey = opts.source.note.toLowerCase();
  const processedByUrl = new Map(opts.processed.map((p) => [p.canonicalUrl, p]));

  const items: NoteBriefCatalogItem[] = [];
  const seen = new Set<string>();
  for (const entry of ledger.values()) {
    if (!(entry.noteNames ?? []).some((n) => n.toLowerCase() === noteKey)) continue;
    if (entry.status !== "ingested" && entry.status !== "failed") continue;
    seen.add(entry.canonicalUrl);
    const fresh = processedByUrl.get(entry.canonicalUrl);
    items.push({
      url: entry.url,
      canonicalUrl: entry.canonicalUrl,
      status: entry.status,
      kind: fresh?.kind ?? entry.kind,
      headline: fresh?.headline ?? entry.headline,
      author: fresh?.author ?? entry.author,
      summary: fresh?.summary,
      error: fresh?.error ?? entry.error,
      detail: fresh?.summary ? undefined : await detailForEntry(opts.provider, entry),
      newlyIngested: fresh?.status === "ingested",
    });
  }
  for (const fresh of opts.processed) {
    if (seen.has(fresh.canonicalUrl)) continue;
    items.push({
      url: fresh.url,
      canonicalUrl: fresh.canonicalUrl,
      status: fresh.status,
      kind: fresh.kind,
      headline: fresh.headline,
      author: fresh.author,
      summary: fresh.summary,
      error: fresh.error,
      newlyIngested: fresh.status === "ingested",
    });
  }

  const existing = await findExistingBrief(opts.provider, opts.source);
  const draft: NoteBriefDraft = {
    folder: opts.source.folder,
    note: opts.source.note,
    archiveNote: opts.source.archiveNote,
    remainingNoteText: plainNoteText(opts.remainingBody),
    previousMarkdown: existing?.text,
    items,
    scannedAt: learnedAt,
  };
  const writer = opts.writer ?? defaultNoteBriefWriter;
  const markdown = (await writer(draft)).trimEnd() + "\n";
  const bytes = Buffer.from(markdown, "utf8");
  const contentHash = hashBytes(bytes);
  const filename = `${slugFromTitle(opts.source.note)}.md`;

  const artifact = await opts.provider.putArtifactBytes(bytes, {
    mimeType: "text/markdown",
    originalFilename: filename,
    name: opts.source.note,
    reindex: true,
  });

  const body = {
    name: opts.source.note,
    text: markdown,
    schemaType: SCHEMA_ORG.DigitalDocument,
    schema: {
      "@type": "DigitalDocument",
      name: opts.source.note,
      encodingFormat: "text/markdown",
      identifier: `notes-inbox-brief:${opts.source.folder}/${opts.source.note}`,
    },
    alfred: {
      entityClass: NOTE_BRIEF_ENTITY_CLASS,
      visibility: "private" as const,
      confidence: 0.85,
      assertionType: "extracted" as const,
    },
    learnedAt,
    contentHash,
    originalFilename: filename,
    provenance: provenance(opts.source, learnedAt, { contentHash }),
    drefs: {
      sourceArtifact: artifact.id,
    },
  };

  const updated = Boolean(existing);
  const doc = existing
    ? await opts.provider.updateRecord(existing.id, body)
    : await opts.provider.createRecord("Entity", body);

  if (doc.id !== opts.source.briefDid) {
    await setXSourceBriefDid(opts.profileId, opts.source.id, doc.id);
    opts.source.briefDid = doc.id;
  }

  return {
    did: doc.id,
    artifactDid: artifact.id,
    markdown,
    updated,
    revision: doc.revision,
  };
}
