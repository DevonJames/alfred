/**
 * MVP public-knowledge store for iOS Brief discovery cards.
 * Candidates come from live public feeds (not private memory).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fetchNewsHeadlines, NEWS_SOURCE_OPTIONS, type NewsHeadline } from "@alfred/briefing";

export interface PublicCandidateRecord {
  id: string;
  url: string;
  title: string;
  summary: string;
  topics: string[];
  matchedInterests: string[];
  score: number;
  indexedAt: string;
}

interface StoreFile {
  items: PublicCandidateRecord[];
}

const DISCLAIMER =
  "Suggested from public sources — not something Alfred remembers about you.";

function storePath(): string {
  const override = process.env.ALFRED_PUBLIC_KNOWLEDGE_PATH;
  if (override) return resolve(override);
  return resolve(process.cwd(), "../../data/desktop-client/public-knowledge.json");
}

async function loadStore(): Promise<StoreFile> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { items: [] };
    throw err;
  }
}

async function saveStore(file: StoreFile): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function candidateId(url: string): string {
  return `pk_${createHash("sha256").update(url.trim()).digest("hex").slice(0, 16)}`;
}

function headlineToCandidate(h: NewsHeadline, interests: string[]): PublicCandidateRecord {
  const url = h.url?.trim() || `https://news.example/${encodeURIComponent(h.title)}`;
  const hay = `${h.title} ${h.source ?? ""}`.toLowerCase();
  const matched = interests.filter((i) => hay.includes(i.toLowerCase()));
  return {
    id: candidateId(url),
    url,
    title: h.title.trim() || "Untitled",
    summary: h.source ? `From ${h.source}` : "Public headline",
    topics: h.source ? [h.source] : [],
    matchedInterests: matched,
    score: matched.length ? 0.7 + matched.length * 0.1 : 0.4,
    indexedAt: new Date().toISOString(),
  };
}

/** Lightweight interest seeds from env or defaults (full interest graph comes later). */
function interestSeeds(): string[] {
  const raw = process.env.ALFRED_PUBLIC_INTERESTS?.trim();
  if (raw) {
    return raw
      .split(/[,|]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return ["AI", "space", "science", "technology", "climate", "markets"];
}

export async function discoverPublicCandidates(limit = 5): Promise<{
  kind: string;
  disclaimer: string;
  candidates: PublicCandidateRecord[];
}> {
  const interests = interestSeeds();
  let headlines: NewsHeadline[] = [];
  try {
    const sources = ["Hacker News", "TechCrunch", "Ars Technica"].filter((s) =>
      NEWS_SOURCE_OPTIONS.includes(s),
    );
    headlines = await fetchNewsHeadlines(sources.length ? sources : NEWS_SOURCE_OPTIONS.slice(0, 3));
  } catch (err) {
    console.warn("[public-knowledge] news fetch failed:", err);
  }

  const fromNews = headlines
    .filter((h) => h.title?.trim())
    .map((h) => headlineToCandidate(h, interests));

  // Prefer interest matches, then score.
  fromNews.sort((a, b) => {
    const am = a.matchedInterests.length;
    const bm = b.matchedInterests.length;
    if (bm !== am) return bm - am;
    return b.score - a.score;
  });

  const picked = fromNews.slice(0, Math.max(1, Math.min(limit, 20)));
  if (picked.length) {
    const store = await loadStore();
    const byId = new Map(store.items.map((i) => [i.id, i]));
    for (const c of picked) byId.set(c.id, c);
    await saveStore({ items: [...byId.values()].slice(-200) });
  }

  return {
    kind: "public_recommendation",
    disclaimer: DISCLAIMER,
    candidates: picked,
  };
}

export async function indexPublicUrl(url: string): Promise<{
  item: PublicCandidateRecord;
  deduped: boolean;
}> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw Object.assign(new Error("url must be http(s)"), { status: 400 });
  }
  const store = await loadStore();
  const id = candidateId(trimmed);
  const existing = store.items.find((i) => i.id === id);
  if (existing) return { item: existing, deduped: true };

  let title = trimmed;
  try {
    title = new URL(trimmed).hostname.replace(/^www\./, "");
  } catch {
    /* keep url */
  }
  const item: PublicCandidateRecord = {
    id,
    url: trimmed,
    title,
    summary: "Saved public link",
    topics: [],
    matchedInterests: [],
    score: 0.5,
    indexedAt: new Date().toISOString(),
  };
  store.items.push(item);
  await saveStore({ items: store.items.slice(-200) });
  return { item, deduped: false };
}

export async function getPublicCandidate(id: string): Promise<PublicCandidateRecord | null> {
  const store = await loadStore();
  return store.items.find((i) => i.id === id) ?? null;
}
