import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  createId,
  type CanonicalMemoryRecord,
  type MemoryProvider,
  type MemoryProviderManifest,
  type MemoryQuery,
  type MemoryRetrievalResult,
  type MemoryTurnCommit,
  type NormalizedMemoryItem,
} from "@alfred/contracts";
import { extractFactsFromUserText, getItemKind } from "./fact-extractor.js";

export const LOCAL_MEMORY_PROVIDER_ID = "memory.local";

/** Walk up from cwd to the monorepo root (package name "alfred"). */
export function resolveRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "alfred") return dir;
      } catch {
        /* continue */
      }
    }
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

export function defaultMemoryPath(profileId: string): string {
  const fromEnv = process.env.ALFRED_MEMORY_PATH;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(resolveRepoRoot(), "data", "memory", `${profileId}.jsonl`);
}

/**
 * Durable JSONL-backed long-term memory (facts + episodic turns).
 * Not a vector DB — keyword/token scoring with facts preferred.
 */
export class LocalFileMemoryProvider implements MemoryProvider {
  readonly manifest: MemoryProviderManifest;
  private items: NormalizedMemoryItem[] = [];
  private loaded = false;
  private reextracted = false;

  constructor(
    private readonly filePath: string,
    id = LOCAL_MEMORY_PROVIDER_ID,
  ) {
    this.manifest = {
      id,
      displayName: "Local File Memory",
      version: "0.2.0",
      capabilities: [
        "retrieve",
        "commit_turn",
        "inspect",
        "edit",
        "delete",
        "import_canonical",
        "export_canonical",
        "file_backed",
        "episodic",
        "editable_blocks",
      ],
    };
  }

  get path(): string {
    return this.filePath;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.items = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parsed = JSON.parse(line) as NormalizedMemoryItem;
          return {
            ...parsed,
            provenance: parsed.provenance ?? {},
          };
        });
    } catch {
      this.items = [];
    }
    this.loaded = true;
    // Backfill facts from historical user turns (e.g. after extractor improvements).
    if (!this.reextracted) {
      this.reextracted = true;
      const scrubbed = this.scrubEchoNameFacts();
      const extracted = this.reextractFactsFromTurns();
      if (scrubbed || extracted) {
        await this.persist();
      }
    }
  }

  /** Drop name facts that are clearly false positives (echo / filler words). */
  private scrubEchoNameFacts(): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => {
      if (i.sourceId !== "fact:name") return true;
      const m = i.content.match(/\bname is\s+([A-Za-z][\w'-]*)/i);
      const name = m?.[1] ?? "";
      if (
        /^(alfred|albert|still|glad|here|just|trying|going|sure|butler)$/i.test(name)
      ) {
        return false;
      }
      return true;
    });
    return this.items.length !== before;
  }

  /** Re-run heuristic extraction over stored user turns; returns true if anything changed. */
  private reextractFactsFromTurns(): boolean {
    let changed = false;
    const before = this.items.filter((i) => getItemKind(i) === "fact").length;
    for (const item of [...this.items]) {
      if (getItemKind(item) !== "turn") continue;
      if (item.provenance?.role !== "user") continue;
      const text = item.content.replace(/^user:\s*/i, "");
      const commit: MemoryTurnCommit = {
        profileId: String(item.provenance?.profileId ?? "profile.default"),
        sessionId: String(item.provenance?.sessionId ?? "reextract"),
        turnId: item.sourceId,
        role: "user",
        text,
        metadata: {},
      };
      const now = item.createdAt || new Date().toISOString();
      for (const fact of extractFactsFromUserText(text)) {
        const existing = this.items.find(
          (i) => i.sourceId === fact.sourceId && getItemKind(i) === "fact",
        );
        if (!existing) {
          this.upsertFact(fact.sourceId, fact.content, now, commit);
          changed = true;
        }
      }
    }
    const after = this.items.filter((i) => getItemKind(i) === "fact").length;
    return changed || after > before;
  }

  /** Atomic persist: write temp then rename. */
  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const body =
      this.items.map((i) => JSON.stringify(i)).join("\n") + (this.items.length ? "\n" : "");
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, this.filePath);
  }

  async retrieve(query: MemoryQuery): Promise<MemoryRetrievalResult> {
    await this.ensureLoaded();
    const limit = query.limit ?? 8;
    const maxFacts = Math.min(4, Math.ceil(limit / 2));
    const maxTurns = Math.max(0, limit - maxFacts);
    const tokens = tokenize(query.text);

    const scored = this.items.map((item) => {
      const kind = getItemKind(item);
      const relevance = scoreItem(item.content, tokens, kind, query.text);
      return { ...item, relevance };
    });

    const facts = scored
      .filter((i) => getItemKind(i) === "fact" || getItemKind(i) === "note")
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, maxFacts);

    const turns = scored
      .filter((i) => getItemKind(i) === "turn")
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, maxTurns);

    // Recall / identity questions: pin durable facts even if keyword overlap is thin.
    if (isRecallQuery(query.text)) {
      const pinned = scored
        .filter((i) => getItemKind(i) === "fact" || getItemKind(i) === "note")
        .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
      for (const fact of pinned) {
        if (facts.some((f) => f.id === fact.id)) continue;
        facts.unshift({ ...fact, relevance: Math.max(fact.relevance ?? 0, 0.9) });
        if (facts.length > maxFacts) facts.pop();
      }
      // Prefer job fact when asking about work.
      if (/\b(job|work|do for a living|occupation|role)\b/i.test(query.text)) {
        const job = scored.find((i) => i.sourceId === "fact:job");
        if (job && !facts.some((f) => f.id === job.id)) {
          facts.unshift({ ...job, relevance: 0.98 });
          if (facts.length > maxFacts) facts.pop();
        }
      }
      const nameFact = scored.find((i) => i.sourceId === "fact:name");
      if (nameFact && !facts.some((f) => f.id === nameFact.id)) {
        facts.unshift({ ...nameFact, relevance: 0.95 });
        if (facts.length > maxFacts) facts.pop();
      }
    }

    const items = [...facts, ...turns]
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, limit);

    return {
      items,
      providerId: this.manifest.id,
      retrievedAt: new Date().toISOString(),
    };
  }

  async commitTurn(commit: MemoryTurnCommit): Promise<void> {
    await this.ensureLoaded();
    const now = new Date().toISOString();

    this.items.push({
      id: createId("mem"),
      content: `${commit.role}: ${commit.text}`,
      sourceId: commit.turnId,
      providerId: this.manifest.id,
      createdAt: now,
      provenance: {
        kind: "turn",
        sessionId: commit.sessionId,
        profileId: commit.profileId,
        role: commit.role,
      },
    });

    if (commit.role === "user") {
      for (const fact of extractFactsFromUserText(commit.text)) {
        this.upsertFact(fact.sourceId, fact.content, now, commit);
      }
    }

    await this.persist();
  }

  private upsertFact(
    sourceId: string,
    content: string,
    now: string,
    commit: MemoryTurnCommit,
  ): void {
    const existing = this.items.find(
      (i) => i.sourceId === sourceId && getItemKind(i) === "fact",
    );
    if (existing) {
      existing.content = content;
      existing.updatedAt = now;
      existing.provenance = {
        ...existing.provenance,
        kind: "fact",
        sessionId: commit.sessionId,
        profileId: commit.profileId,
        turnId: commit.turnId,
      };
      return;
    }
    this.items.push({
      id: createId("mem"),
      content,
      sourceId,
      providerId: this.manifest.id,
      createdAt: now,
      provenance: {
        kind: "fact",
        sessionId: commit.sessionId,
        profileId: commit.profileId,
        turnId: commit.turnId,
      },
    });
  }

  async inspect(limit = 100): Promise<NormalizedMemoryItem[]> {
    await this.ensureLoaded();
    // Facts first, then newest turns.
    const facts = this.items.filter((i) => getItemKind(i) === "fact" || getItemKind(i) === "note");
    const turns = this.items
      .filter((i) => getItemKind(i) === "turn")
      .slice()
      .reverse();
    return [...facts, ...turns].slice(0, limit);
  }

  async edit(id: string, content: string): Promise<void> {
    await this.ensureLoaded();
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`Memory item not found: ${id}`);
    item.content = content;
    item.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    this.items = this.items.filter((i) => i.id !== id);
    await this.persist();
  }

  async exportCanonical(): Promise<CanonicalMemoryRecord[]> {
    await this.ensureLoaded();
    return this.items.map((i) => ({
      id: i.id,
      content: i.content,
      createdAt: i.createdAt,
      metadata: {
        ...i.provenance,
        sourceId: i.sourceId,
        providerId: i.providerId,
      },
    }));
  }

  async importCanonical(records: CanonicalMemoryRecord[]): Promise<void> {
    await this.ensureLoaded();
    for (const r of records) {
      const meta = r.metadata ?? {};
      const sourceId = typeof meta.sourceId === "string" ? meta.sourceId : r.id;
      const kind =
        meta.kind === "fact" || meta.kind === "note" || meta.kind === "turn"
          ? meta.kind
          : "note";
      const existingIdx = this.items.findIndex((i) => i.id === r.id || i.sourceId === sourceId);
      const item: NormalizedMemoryItem = {
        id: r.id,
        content: r.content,
        sourceId,
        providerId: this.manifest.id,
        createdAt: r.createdAt ?? new Date().toISOString(),
        provenance: { ...meta, kind },
      };
      if (existingIdx >= 0) this.items[existingIdx] = item;
      else this.items.push(item);
    }
    await this.persist();
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function scoreItem(
  content: string,
  tokens: string[],
  kind: "fact" | "turn" | "note",
  query: string,
): number {
  const hay = content.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;

  if (kind === "fact" || kind === "note") score += 0.35;
  if (hay.includes(q) && q.length > 3) score += 0.5;

  if (tokens.length > 0) {
    let hits = 0;
    for (const t of tokens) {
      if (hay.includes(t)) hits += 1;
    }
    score += (hits / tokens.length) * 0.45;
  }

  // Identity / recall boosts
  if (kind === "fact" || kind === "note") {
    if (/\bname\b/i.test(query) && /\bname is\b/i.test(content)) score += 0.4;
    if (/\b(job|work|role)\b/i.test(query) && /\b(job|role)\b/i.test(content)) score += 0.4;
    if (isRecallQuery(query)) score += 0.25;
  }

  return Math.min(1, score);
}

function isRecallQuery(text: string): boolean {
  return /\b(who am i|what'?s my|what is my|do you remember|what did i (tell|say)|remind me|my name|my job|where do i live|what do you know about me)\b/i.test(
    text,
  );
}
