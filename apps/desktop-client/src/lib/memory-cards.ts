import type { MemoryRevision } from "@alfred/memory";

export const MEMORY_CARD_CATEGORIES = [
  "family",
  "health",
  "preferences",
  "devices",
  "playbooks",
] as const;

export type MemoryCardCategory = (typeof MEMORY_CARD_CATEGORIES)[number];

export type MemoryCard = {
  id: string;
  category: MemoryCardCategory;
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

const CATEGORY_SET = new Set<string>(MEMORY_CARD_CATEGORIES);

export function isConversationTurn(rev: MemoryRevision): boolean {
  return rev.provenance?.sourceType === "conversation_turn";
}

export function revisionToCard(rev: MemoryRevision): MemoryCard {
  const provenance = (rev.provenance ?? {}) as Record<string, unknown>;
  const rawCategory = provenance.alfredHomeCategory;
  const category = (
    typeof rawCategory === "string" && CATEGORY_SET.has(rawCategory)
      ? rawCategory
      : rev.type === "Entity"
        ? "family"
        : "preferences"
  ) as MemoryCardCategory;

  return {
    id: rev.id,
    category,
    title: rev.name?.trim() || (rev.text ? rev.text.slice(0, 80) : "Memory"),
    content: rev.text ?? rev.name ?? "",
    metadata: {
      type: rev.type,
      revision: rev.revision,
      ...provenance,
    },
    createdAt: rev.createdAt,
    updatedAt: rev.updatedAt,
  };
}

export function parseCategory(value: unknown): MemoryCardCategory | undefined {
  if (typeof value === "string" && CATEGORY_SET.has(value)) {
    return value as MemoryCardCategory;
  }
  return undefined;
}
