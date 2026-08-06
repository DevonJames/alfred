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

    // If query looks identity-related, ensure name fact is included when present.
    if (/\b(name|who am i|what's my|what is my)\b/i.test(query.text)) {
      const nameFact = scored.find((i) => i.sourceId === "fact:name");
      if (nameFact && !facts.some((f) => f.id === nameFact.id)) {
        facts.unshift({ ...nameFact, relevance: Math.max(nameFact.relevance ?? 0, 0.95) });
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

  // Identity boost
  if (
    (kind === "fact" || kind === "note") &&
    /\bname\b/i.test(query) &&
    /\bname is\b/i.test(content)
  ) {
    score += 0.4;
  }

  return Math.min(1, score);
}
