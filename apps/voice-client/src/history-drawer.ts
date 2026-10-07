export type HistorySummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modality: "voice" | "chat" | "mixed";
  stack?: string;
  preview: string;
  messageCount: number;
};

export type HistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  source: "voice" | "text";
};

function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const sec = Math.round((now - t) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

/** Side drawer listing durable Talk conversations. */
export class HistoryDrawer {
  private open = false;
  private activeId: string | null = null;
  private items: HistorySummary[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly listEl: HTMLElement,
    private readonly apiPath: (path: string) => string,
    private readonly onSelect: (id: string, messages: HistoryMessage[]) => void,
    private readonly onNew: () => void,
  ) {
    this.root.hidden = true;
    this.listEl.addEventListener("click", (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-conv-id]");
      if (!btn?.dataset.convId) return;
      void this.select(btn.dataset.convId);
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  setOpen(next: boolean): void {
    this.open = next;
    this.root.hidden = !next;
    this.root.classList.toggle("open", next);
    document.body.classList.toggle("history-open", next);
    if (next) void this.refresh();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch(this.apiPath("/api/conversations"));
      if (!res.ok) throw new Error(`list failed (${res.status})`);
      const data = (await res.json()) as {
        conversations?: HistorySummary[];
        activeId?: string | null;
      };
      this.items = data.conversations ?? [];
      this.activeId = data.activeId ?? null;
      this.renderList();
    } catch (err) {
      console.warn("[voice-client] history list failed", err);
      this.listEl.innerHTML = `<p class="history-empty">Couldn't load history.</p>`;
    }
  }

  async ensureActive(opts?: { forceNew?: boolean; stack?: string }): Promise<string | null> {
    try {
      const res = await fetch(this.apiPath("/api/conversations/active"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          forceNew: opts?.forceNew === true,
          stack: opts?.stack,
        }),
      });
      if (!res.ok) throw new Error(`active failed (${res.status})`);
      const data = (await res.json()) as { conversation?: { id: string } };
      this.activeId = data.conversation?.id ?? null;
      if (this.open) void this.refresh();
      return this.activeId;
    } catch (err) {
      console.warn("[voice-client] ensure active conversation failed", err);
      return null;
    }
  }

  async prepareNew(): Promise<void> {
    try {
      await fetch(this.apiPath("/api/conversations/new"), { method: "POST" });
      this.activeId = null;
      this.onNew();
      if (this.open) void this.refresh();
    } catch (err) {
      console.warn("[voice-client] new conversation failed", err);
    }
  }

  async appendLocalTurn(opts: {
    role: "user" | "assistant";
    text: string;
    source: "voice" | "text";
  }): Promise<void> {
    try {
      await fetch(this.apiPath("/api/conversations/active/messages"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (this.open) void this.refresh();
    } catch (err) {
      console.warn("[voice-client] append history failed", err);
    }
  }

  private async select(id: string): Promise<void> {
    try {
      const res = await fetch(this.apiPath("/api/conversations/active"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(`resume failed (${res.status})`);
      const data = (await res.json()) as {
        conversation?: { id: string; messages?: HistoryMessage[] };
      };
      this.activeId = data.conversation?.id ?? id;
      this.onSelect(this.activeId, data.conversation?.messages ?? []);
      this.renderList();
    } catch (err) {
      console.warn("[voice-client] resume conversation failed", err);
    }
  }

  private renderList(): void {
    this.listEl.replaceChildren();
    if (!this.items.length) {
      this.listEl.innerHTML = `<p class="history-empty">No conversations yet.</p>`;
      return;
    }
    for (const item of this.items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item";
      btn.dataset.convId = item.id;
      if (item.id === this.activeId) btn.classList.add("active");
      btn.innerHTML = `
        <span class="history-item-title">${escapeHtml(item.title || "Conversation")}</span>
        <span class="history-item-meta">
          <span class="history-chip">${escapeHtml(item.modality)}</span>
          <span>${escapeHtml(relativeTime(item.updatedAt))}</span>
        </span>
        ${item.preview ? `<span class="history-item-preview">${escapeHtml(item.preview)}</span>` : ""}
      `;
      this.listEl.appendChild(btn);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
