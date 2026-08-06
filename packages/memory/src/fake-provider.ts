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

export class FakeMemoryProvider implements MemoryProvider {
  readonly manifest: MemoryProviderManifest;
  private readonly items: NormalizedMemoryItem[] = [];

  constructor(id = "memory.fake", seed: Array<{ content: string; id?: string }> = []) {
    this.manifest = {
      id,
      displayName: "Fake Memory",
      version: "0.1.0",
      capabilities: [
        "retrieve",
        "commit_turn",
        "inspect",
        "edit",
        "delete",
        "import_canonical",
        "export_canonical",
        "episodic",
      ],
    };
    for (const s of seed) {
      this.items.push({
        id: s.id ?? createId("mem"),
        content: s.content,
        sourceId: s.id ?? "seed",
        providerId: id,
        createdAt: new Date().toISOString(),
        relevance: 1,
        provenance: { kind: "seed" },
      });
    }
  }

  async retrieve(query: MemoryQuery): Promise<MemoryRetrievalResult> {
    const q = query.text.toLowerCase();
    const scored = this.items
      .map((item) => {
        const hay = item.content.toLowerCase();
        const relevance = hay.includes(q)
          ? 0.9
          : q.split(/\s+/).some((w) => hay.includes(w))
            ? 0.5
            : 0.1;
        return { ...item, relevance };
      })
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, query.limit);

    return {
      items: scored,
      providerId: this.manifest.id,
      retrievedAt: new Date().toISOString(),
    };
  }

  async commitTurn(commit: MemoryTurnCommit): Promise<void> {
    this.items.push({
      id: createId("mem"),
      content: `${commit.role}: ${commit.text}`,
      sourceId: commit.turnId,
      providerId: this.manifest.id,
      createdAt: new Date().toISOString(),
      provenance: { sessionId: commit.sessionId, profileId: commit.profileId },
    });
  }

  async inspect(limit = 100): Promise<NormalizedMemoryItem[]> {
    return this.items.slice(0, limit);
  }

  async edit(id: string, content: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`Memory item not found: ${id}`);
    item.content = content;
    item.updatedAt = new Date().toISOString();
  }

  async delete(id: string): Promise<void> {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx >= 0) this.items.splice(idx, 1);
  }

  async exportCanonical(): Promise<CanonicalMemoryRecord[]> {
    return this.items.map((i) => ({
      id: i.id,
      content: i.content,
      createdAt: i.createdAt,
      metadata: i.provenance,
    }));
  }

  async importCanonical(records: CanonicalMemoryRecord[]): Promise<void> {
    for (const r of records) {
      this.items.push({
        id: r.id,
        content: r.content,
        sourceId: r.id,
        providerId: this.manifest.id,
        createdAt: r.createdAt,
        provenance: r.metadata,
      });
    }
  }
}
