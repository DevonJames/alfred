import { parseMemoryRef } from "./oip-local/ids.js";
import { hashBytes } from "./oip-local/hashing.js";
import type { OipLocalMemoryProvider } from "./oip-local/provider.js";
import { SCHEMA_ORG } from "./oip-local/schema-org.js";
import type { MemoryRevision } from "./oip-local/schemas.js";

export const GRAPH_REPORT_ENTITY_CLASS = "graph_view_report";
export const MAX_GRAPH_REPORT_TEXT = 8000;
export const GRAPH_REPORT_BATCH_CHARS = 32_000;
export const GRAPH_REPORT_MAX_OUTPUT_TOKENS = 16_384;

export const GRAPH_REPORT_EXTRACT_SYSTEM =
  "You extract every distinct claim from Alfred memories for a later exhaustive report. " +
  "Do not write a summary, overview, or themed briefing. Bullet markdown only. " +
  "For each claim record: the behavior or tendency; the deficiency, chemical, or mechanism if the memory states one; " +
  "why that mechanism produces that behavior if stated; a short distinctive quote; and the source memory name. " +
  "A memory with multiple claims must produce multiple bullets. Skipping a claim is a failure. Do not invent.";

export const GRAPH_REPORT_COMPILE_SYSTEM =
  "You compile an exhaustive reference document from extracted memory claims. " +
  "This is not a short briefing. Do not collapse the material into a handful of theme paragraphs. " +
  "Follow the user's focus exactly. Deduplicate only identical claims (same behavior + same cause + same reason). " +
  "If one cause produces several behaviors, keep all of them. If one behavior has several causes, keep all causes and explain each. " +
  "Synthesize overlapping claims into the richest combined entry without dropping unique details. " +
  "Use only facts in the extracts. Markdown only, starting with the requested title heading. " +
  "The document must be long and thorough — many specific entries, grouped for readability. " +
  "A 5–10 point overview of hundreds of memories is a failure.";

export interface GraphReportView {
  from?: string;
  to?: string;
  date?: string;
}

export interface GraphReportMemory {
  id: string;
  name: string;
  type: string;
  text: string;
}

export interface GraphReportDraft {
  title: string;
  prompt: string;
  view: GraphReportView;
  memories: GraphReportMemory[];
  generatedAt: string;
}

export type GraphReportWriter = (draft: GraphReportDraft) => Promise<string>;

export interface GraphReportProgress {
  label: string;
  percent: number;
  current: number;
  total: number;
}

export type GraphReportProgressHandler = (
  progress: GraphReportProgress,
) => void | Promise<void>;

export interface GraphReportWriteResult {
  did: string;
  artifactDid: string;
  title: string;
  markdown: string;
  filename: string;
  linkedCount: number;
  usedCount: number;
  requestedCount: number;
  truncated: boolean;
}

const DEFAULT_PROMPT =
  "Write a briefing of these memories: main themes, distinctive claims, disagreements, and what is worth remembering.";

export function asMemoryDid(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith("did:memory:") ? trimmed : `did:memory:${trimmed}`;
}

export function slugFromReportTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 60) || "graph-report";
}

export function titleFromReportPrompt(prompt: string, view?: GraphReportView): string {
  const line = prompt.trim().split(/\n/)[0]?.replace(/^#+\s*/, "").trim() ?? "";
  if (line && line.length <= 80) return line;
  if (line) return `${line.slice(0, 77)}…`;
  const from = view?.from?.trim();
  if (from) return `Report: ${from}`;
  return "Graph report";
}

export function revisionPlainText(rev: MemoryRevision): string {
  const schema = (rev.schema ?? {}) as Record<string, unknown>;
  const bits = [
    rev.text,
    typeof schema.description === "string" ? schema.description : "",
    typeof schema.text === "string" ? schema.text : "",
    typeof schema.abstract === "string" ? schema.abstract : "",
  ];
  const joined = bits
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n\n");
  return joined.replace(/\s+\n/g, "\n").trim();
}

export function rankMemoriesForReport(
  items: GraphReportMemory[],
  limit?: number,
): GraphReportMemory[] {
  const ranked = [...items].sort(
    (a, b) => b.text.length - a.text.length || a.name.localeCompare(b.name),
  );
  if (limit == null || limit <= 0) return ranked;
  return ranked.slice(0, limit);
}

function catalogLine(item: GraphReportMemory): string {
  const text = item.text.replace(/\s+/g, " ").trim().slice(0, MAX_GRAPH_REPORT_TEXT);
  return `### ${item.name || item.id} (${item.type})\n${text || "(no text)"}\n`;
}

export function chunkMemoriesForReport(
  items: GraphReportMemory[],
  maxChars = GRAPH_REPORT_BATCH_CHARS,
): GraphReportMemory[][] {
  const batches: GraphReportMemory[][] = [];
  let current: GraphReportMemory[] = [];
  let size = 0;
  for (const item of items) {
    const n = catalogLine(item).length;
    if (current.length && size + n > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += n;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function fallbackGraphReportMarkdown(draft: GraphReportDraft): string {
  const lines: string[] = [`# ${draft.title}`, ""];
  const scope = viewScopeLine(draft.view, draft.memories.length, draft.generatedAt);
  if (scope) lines.push(scope, "");
  if (draft.prompt.trim()) {
    lines.push("## Focus", "", draft.prompt.trim(), "");
  }
  lines.push("## Memories", "");
  for (const item of draft.memories) {
    lines.push(catalogLine(item));
  }
  return `${lines.join("\n").trim()}\n`;
}

function ensureReportScope(markdown: string, draft: GraphReportDraft): string {
  const scope = viewScopeLine(draft.view, draft.memories.length, draft.generatedAt);
  if (!scope) return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  if (markdown.includes(scope)) return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  const lines = markdown.replace(/\s+$/, "").split("\n");
  if (lines[0]?.startsWith("# ")) {
    lines.splice(1, 0, "", scope);
    return `${lines.join("\n")}\n`;
  }
  return `# ${draft.title}\n\n${scope}\n\n${markdown.trimStart()}`;
}

function viewScopeLine(view: GraphReportView, count: number, generatedAt: string): string {
  const bits = [
    view.from?.trim() ? `from “${view.from.trim()}”` : "",
    view.to?.trim() ? `to “${view.to.trim()}”` : "",
    view.date?.trim() ? `date “${view.date.trim()}”` : "",
  ].filter(Boolean);
  const when = generatedAt.slice(0, 10);
  const lens = bits.length ? ` Graph view ${bits.join(" · ")}.` : "";
  return `Generated ${when} from ${count} shown memor${count === 1 ? "y" : "ies"}.${lens}`;
}

export function graphReportLooksThin(markdown: string, memoryCount: number): boolean {
  const body = markdown.replace(/^#.*$/m, "").trim();
  const minChars = Math.min(120_000, Math.max(10_000, memoryCount * 70));
  return body.length < minChars;
}

async function completeChat(opts: {
  url: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
}): Promise<string | undefined> {
  const base = {
    model: opts.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  const attempts: Record<string, unknown>[] = [
    { ...base, max_completion_tokens: GRAPH_REPORT_MAX_OUTPUT_TOKENS },
    { ...base, max_tokens: GRAPH_REPORT_MAX_OUTPUT_TOKENS },
  ];
  for (const payload of attempts) {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) continue;
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (text) return text;
  }
  return undefined;
}

async function llmComplete(system: string, user: string): Promise<string | undefined> {
  const openai = process.env.OPENAI_API_KEY?.trim();
  const grok = process.env.GROK_API_KEY?.trim() || process.env.XAI_API_KEY?.trim();
  const openaiModel =
    process.env.OPENAI_GRAPH_REPORT_MODEL?.trim() ||
    process.env.OPENAI_NOTE_BRIEF_MODEL?.trim() ||
    process.env.OPENAI_DOCS_EXTRACT_MODEL?.trim() ||
    "gpt-5.6-terra";
  const grokModel = process.env.ALFRED_NOTES_GROK_MODEL?.trim() || "grok-4-fast-reasoning";
  if (openai) {
    const hit = await completeChat({
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: openai,
      model: openaiModel,
      system,
      user,
    });
    if (hit) return hit;
  }
  if (grok) {
    return completeChat({
      url: "https://api.x.ai/v1/chat/completions",
      apiKey: grok,
      model: grokModel,
      system,
      user,
    });
  }
  return undefined;
}

function compileUserPrompt(draft: GraphReportDraft, extracts: string): string {
  return `Title: ${draft.title}
${viewScopeLine(draft.view, draft.memories.length, draft.generatedAt)}

Focus from the user (follow exactly — exhaustive catalog, not a short summary):
${draft.prompt}

Extracted claims:
${extracts}
`;
}

async function llmGraphReportMarkdown(
  draft: GraphReportDraft,
  onProgress?: GraphReportProgressHandler,
): Promise<string | undefined> {
  const batches = chunkMemoriesForReport(draft.memories);
  const extracts: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    await onProgress?.({
      label: batches.length > 1 ? `Extracting batch ${i + 1} of ${batches.length}…` : "Extracting claims…",
      percent: 12 + Math.round(((i + 1) / Math.max(batches.length, 1)) * 50),
      current: i + 1,
      total: batches.length,
    });
    const catalog = batch.map(catalogLine).join("\n");
    const partial = await llmComplete(
      GRAPH_REPORT_EXTRACT_SYSTEM,
      `Batch ${i + 1} of ${batches.length} for exhaustive report "${draft.title}".
User focus:
${draft.prompt}

Extract every distinct claim. Do not summarize this batch into a few bullets if the memories contain more.

Memories:
${catalog}
`,
    );
    extracts.push(
      partial || batch.map((item) => `- ${item.name}: ${item.text.slice(0, 1200)}`).join("\n"),
    );
  }
  const joined = extracts.map((s, i) => `## Batch ${i + 1}\n${s}`).join("\n\n");
  await onProgress?.({
    label: "Compiling the full report…",
    percent: 78,
    current: batches.length,
    total: batches.length,
  });
  let compiled = await llmComplete(GRAPH_REPORT_COMPILE_SYSTEM, compileUserPrompt(draft, joined));
  if (compiled && graphReportLooksThin(compiled, draft.memories.length)) {
    await onProgress?.({
      label: "Draft was too short — expanding unique claims…",
      percent: 88,
      current: batches.length,
      total: batches.length,
    });
    const expanded = await llmComplete(
      GRAPH_REPORT_COMPILE_SYSTEM,
      `The draft below is too short for ${draft.memories.length} memories. It dropped unique claims.
Expand it into the exhaustive reference the user asked for. Keep every distinct behavior, cause, and mechanism from the extracts.
Do not replace the draft with a shorter overview.

${compileUserPrompt(draft, joined)}

Too-short draft:
${compiled}
`,
    );
    if (expanded) compiled = expanded;
  }
  return compiled;
}

export async function defaultGraphReportWriter(
  draft: GraphReportDraft,
  onProgress?: GraphReportProgressHandler,
): Promise<string> {
  try {
    const llm = await llmGraphReportMarkdown(draft, onProgress);
    if (llm) return llm.endsWith("\n") ? llm : `${llm}\n`;
  } catch {
    /* fall through */
  }
  return fallbackGraphReportMarkdown(draft);
}

async function loadReportMemories(
  provider: OipLocalMemoryProvider,
  nodeIds: string[],
  onProgress?: GraphReportProgressHandler,
): Promise<{ memories: GraphReportMemory[]; requestedCount: number }> {
  const seen = new Set<string>();
  const loaded: GraphReportMemory[] = [];
  const ids = nodeIds.map(asMemoryDid).filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  let i = 0;
  for (const id of ids) {
    i += 1;
    if (i === 1 || i % 25 === 0 || i === ids.length) {
      await onProgress?.({
        label: `Loading memories (${i} of ${ids.length})…`,
        percent: Math.round((i / Math.max(ids.length, 1)) * 10),
        current: i,
        total: ids.length,
      });
    }
    let logicalId = id;
    try {
      logicalId = parseMemoryRef(id).logicalId;
    } catch {
      logicalId = id.replace(/^did:memory:/, "");
    }
    const rev =
      (await provider.packages.readCurrent(logicalId)) ??
      (await provider.packages.readCurrent(id.replace(/^did:memory:/, "")));
    if (!rev) continue;
    const name = (rev.name || "").trim() || rev.type;
    const text = revisionPlainText(rev);
    if (!name && !text) continue;
    loaded.push({
      id: rev.id,
      name,
      type: rev.type,
      text,
    });
  }
  return { memories: loaded, requestedCount: ids.length };
}

export async function writeGraphViewReport(opts: {
  provider: OipLocalMemoryProvider;
  nodeIds: string[];
  prompt?: string;
  title?: string;
  view?: GraphReportView;
  now?: Date;
  writer?: GraphReportWriter;
  onProgress?: GraphReportProgressHandler;
}): Promise<GraphReportWriteResult> {
  const now = opts.now ?? new Date();
  const generatedAt = now.toISOString();
  const prompt = opts.prompt?.trim() || DEFAULT_PROMPT;
  const view = opts.view ?? {};
  await opts.onProgress?.({
    label: "Loading memories…",
    percent: 2,
    current: 0,
    total: opts.nodeIds.length,
  });
  const { memories: loaded, requestedCount } = await loadReportMemories(
    opts.provider,
    opts.nodeIds,
    opts.onProgress,
  );
  if (!loaded.length) {
    throw new Error("None of the shown memories had readable text.");
  }
  const memories = rankMemoriesForReport(loaded);
  const truncated = memories.length < requestedCount;
  const title = (opts.title?.trim() || titleFromReportPrompt(prompt, view)).trim() || "Graph report";
  const draft: GraphReportDraft = {
    title,
    prompt,
    view,
    memories,
    generatedAt,
  };
  await opts.onProgress?.({
    label: `Writing from all ${memories.length} shown memories…`,
    percent: 12,
    current: 0,
    total: memories.length,
  });
  const writer = opts.writer ?? ((next: GraphReportDraft) => defaultGraphReportWriter(next, opts.onProgress));
  const markdown = ensureReportScope((await writer(draft)).trimEnd() + "\n", draft);
  const bytes = Buffer.from(markdown, "utf8");
  const contentHash = hashBytes(bytes);
  const filename = `${slugFromReportTitle(title)}.md`;
  await opts.onProgress?.({
    label: "Saving report artifact…",
    percent: 90,
    current: memories.length,
    total: memories.length,
  });
  const artifact = await opts.provider.putArtifactBytes(bytes, {
    mimeType: "text/markdown",
    originalFilename: filename,
    name: title,
    reindex: true,
  });
  const about = memories.map((item) => item.id);
  const doc = await opts.provider.createRecord("Entity", {
    name: title,
    text: markdown,
    schemaType: SCHEMA_ORG.DigitalDocument,
    schema: {
      "@type": "DigitalDocument",
      name: title,
      encodingFormat: "text/markdown",
      abstract: prompt.slice(0, 400),
    },
    alfred: {
      entityClass: GRAPH_REPORT_ENTITY_CLASS,
      visibility: "private" as const,
      confidence: 0.85,
      assertionType: "extracted" as const,
    },
    learnedAt: generatedAt,
    contentHash,
    originalFilename: filename,
    provenance: {
      sourceType: "graph_view_report",
      extractionMethod: "graph_view_report",
      learnedAt: generatedAt,
      viewFrom: view.from,
      viewTo: view.to,
      viewDate: view.date,
      prompt,
      contentHash,
    },
    drefs: {
      sourceArtifact: artifact.id,
      about,
    },
  });
  await opts.onProgress?.({
    label: "Done",
    percent: 100,
    current: memories.length,
    total: memories.length,
  });
  return {
    did: doc.id,
    artifactDid: artifact.id,
    title,
    markdown,
    filename,
    linkedCount: about.length,
    usedCount: memories.length,
    requestedCount,
    truncated,
  };
}
