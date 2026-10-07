import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { IDLE_MERGE_MS, defaultConversationsDir } from "./paths.js";
import type {
  ConversationIndexFile,
  ConversationMessage,
  ConversationModality,
  ConversationRecord,
  ConversationStack,
  ConversationSummary,
  MessageSource,
} from "./types.js";

const EMPTY_INDEX: ConversationIndexFile = {
  activeId: null,
  forceNewNext: false,
  conversations: [],
};

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function titleFromText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New conversation";
  return clean.length > 60 ? `${clean.slice(0, 57).trim()}…` : clean;
}

function mergeModality(
  current: ConversationModality | undefined,
  source: MessageSource,
  role: "user" | "assistant",
): ConversationModality {
  if (role !== "user") return current ?? (source === "text" ? "chat" : "voice");
  const incoming: ConversationModality = source === "text" ? "chat" : "voice";
  if (!current) return incoming;
  if (current === "mixed") return "mixed";
  if (current !== incoming) return "mixed";
  return current;
}

function toSummary(record: ConversationRecord): ConversationSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    modality: record.modality,
    stack: record.stack,
    preview: record.preview,
    messageCount: record.messageCount,
  };
}

export class ConversationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private indexCache: ConversationIndexFile | null = null;

  constructor(readonly dir: string) {}

  private get indexPath(): string {
    return path.join(this.dir, "index.json");
  }

  private recordPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async readIndex(): Promise<ConversationIndexFile> {
    if (this.indexCache) return this.indexCache;
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ConversationIndexFile>;
      this.indexCache = {
        activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
        forceNewNext: Boolean(parsed.forceNewNext),
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      };
    } catch {
      this.indexCache = { ...EMPTY_INDEX, conversations: [] };
    }
    return this.indexCache;
  }

  private async writeIndex(index: ConversationIndexFile): Promise<void> {
    await this.ensureDir();
    this.indexCache = index;
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tmp, this.indexPath);
  }

  private async readRecord(id: string): Promise<ConversationRecord | null> {
    try {
      const raw = await readFile(this.recordPath(id), "utf8");
      return JSON.parse(raw) as ConversationRecord;
    } catch {
      return null;
    }
  }

  private async writeRecord(record: ConversationRecord): Promise<void> {
    await this.ensureDir();
    const tmp = `${this.recordPath(record.id)}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tmp, this.recordPath(record.id));
  }

  private async upsertSummary(summary: ConversationSummary): Promise<void> {
    const index = await this.readIndex();
    const rest = index.conversations.filter((c) => c.id !== summary.id);
    index.conversations = [summary, ...rest].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    );
    await this.writeIndex(index);
  }

  async list(): Promise<ConversationSummary[]> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      return [...index.conversations].sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      );
    });
  }

  async get(id: string): Promise<ConversationRecord | null> {
    return this.enqueue(async () => this.readRecord(id));
  }

  async getActiveId(): Promise<string | null> {
    return this.enqueue(async () => (await this.readIndex()).activeId);
  }

  /** Mark that the next ensureActive should open a fresh conversation. */
  async prepareNew(): Promise<void> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      index.forceNewNext = true;
      index.activeId = null;
      await this.writeIndex(index);
    });
  }

  async setActive(id: string): Promise<ConversationRecord | null> {
    return this.enqueue(async () => {
      const record = await this.readRecord(id);
      if (!record) return null;
      const index = await this.readIndex();
      index.activeId = id;
      index.forceNewNext = false;
      await this.writeIndex(index);
      return record;
    });
  }

  async createNew(opts?: {
    stack?: ConversationStack;
    now?: Date;
  }): Promise<ConversationRecord> {
    return this.enqueue(async () => this.createNewUnlocked(opts));
  }

  private async createNewUnlocked(opts?: {
    stack?: ConversationStack;
    now?: Date;
  }): Promise<ConversationRecord> {
    const now = (opts?.now ?? new Date()).toISOString();
    const record: ConversationRecord = {
      id: createId("conv"),
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      modality: "voice",
      stack: opts?.stack,
      preview: "",
      messageCount: 0,
      messages: [],
    };
    await this.writeRecord(record);
    const index = await this.readIndex();
    index.activeId = record.id;
    index.forceNewNext = false;
    await this.upsertSummary(toSummary(record));
    const after = await this.readIndex();
    after.activeId = record.id;
    after.forceNewNext = false;
    await this.writeIndex(after);
    return record;
  }

  /**
   * Reuse the active conversation when it was updated within idleMergeMs;
   * otherwise create a new one. forceNew / forceNewNext always create.
   */
  async ensureActive(opts?: {
    forceNew?: boolean;
    idleMergeMs?: number;
    now?: Date;
    stack?: ConversationStack;
  }): Promise<ConversationRecord> {
    return this.enqueue(async () => {
      const now = opts?.now ?? new Date();
      const idleMs = opts?.idleMergeMs ?? IDLE_MERGE_MS;
      const index = await this.readIndex();

      if (opts?.forceNew || index.forceNewNext) {
        return this.createNewUnlocked({ stack: opts?.stack, now });
      }

      if (index.activeId) {
        const existing = await this.readRecord(index.activeId);
        if (existing) {
          const updatedMs = Date.parse(existing.updatedAt);
          if (Number.isFinite(updatedMs) && now.getTime() - updatedMs <= idleMs) {
            if (opts?.stack && !existing.stack) {
              existing.stack = opts.stack;
              await this.writeRecord(existing);
              await this.upsertSummary(toSummary(existing));
            }
            return existing;
          }
        }
      }

      return this.createNewUnlocked({ stack: opts?.stack, now });
    });
  }

  async appendMessage(opts: {
    conversationId?: string;
    role: "user" | "assistant";
    text: string;
    source: MessageSource;
    stack?: ConversationStack;
    now?: Date;
  }): Promise<{ conversation: ConversationRecord; message: ConversationMessage }> {
    return this.enqueue(async () => {
      const text = opts.text.replace(/\s+/g, " ").trim();
      if (!text) {
        throw new Error("message text is required");
      }
      const now = opts.now ?? new Date();
      const at = now.toISOString();

      let record: ConversationRecord | null = null;
      if (opts.conversationId) {
        record = await this.readRecord(opts.conversationId);
      }
      if (!record) {
        // Inline ensureActive without re-entering the queue.
        const index = await this.readIndex();
        if (!index.forceNewNext && index.activeId) {
          const existing = await this.readRecord(index.activeId);
          if (existing) {
            const updatedMs = Date.parse(existing.updatedAt);
            if (Number.isFinite(updatedMs) && now.getTime() - updatedMs <= IDLE_MERGE_MS) {
              record = existing;
            }
          }
        }
        if (!record) {
          record = await this.createNewUnlocked({ stack: opts.stack, now });
        }
      }

      const last = record.messages[record.messages.length - 1];
      if (last && last.role === opts.role && last.text === text) {
        return { conversation: record, message: last };
      }

      const message: ConversationMessage = {
        id: createId("msg"),
        role: opts.role,
        text,
        at,
        source: opts.source,
      };

      if (opts.role === "user" && record.messageCount === 0) {
        record.title = titleFromText(text);
      }
      record.modality = mergeModality(record.modality, opts.source, opts.role);
      if (opts.stack) record.stack = opts.stack;
      record.messages.push(message);
      record.messageCount = record.messages.length;
      record.preview = text.length > 120 ? `${text.slice(0, 117).trim()}…` : text;
      record.updatedAt = at;

      await this.writeRecord(record);
      const index = await this.readIndex();
      index.activeId = record.id;
      index.forceNewNext = false;
      await this.writeIndex(index);
      await this.upsertSummary(toSummary(record));
      return { conversation: record, message };
    });
  }
}

const stores = new Map<string, ConversationStore>();

export function createConversationStore(opts?: {
  profileId?: string;
  dir?: string;
}): ConversationStore {
  const dir = defaultConversationsDir(opts?.profileId, opts?.dir);
  let store = stores.get(dir);
  if (!store) {
    store = new ConversationStore(dir);
    stores.set(dir, store);
  }
  return store;
}

/** Test helper — drop cached singleton for a dir. */
export function resetConversationStoreCache(): void {
  stores.clear();
}
