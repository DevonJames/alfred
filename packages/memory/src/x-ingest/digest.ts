import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultBriefingCacheFile, defaultXIngestDigestPath } from "./paths.js";
import type { XIngestDigest, XIngestDigestItem } from "./types.js";

export async function loadXIngestDigest(
  profileId: string,
  dayKey: string,
  cacheDir?: string,
): Promise<XIngestDigest | null> {
  try {
    const raw = await readFile(defaultXIngestDigestPath(profileId, dayKey, cacheDir), "utf8");
    return JSON.parse(raw) as XIngestDigest;
  } catch {
    return null;
  }
}

export async function appendXIngestDigest(
  profileId: string,
  dayKey: string,
  items: XIngestDigestItem[],
  now = new Date(),
): Promise<XIngestDigest> {
  const existing = (await loadXIngestDigest(profileId, dayKey)) ?? {
    dayKey,
    items: [],
    updatedAt: now.toISOString(),
  };
  const byUrl = new Map(existing.items.map((i) => [i.canonicalUrl, i]));
  for (const item of items) {
    byUrl.set(item.canonicalUrl, item);
  }
  const next: XIngestDigest = {
    dayKey,
    items: [...byUrl.values()],
    updatedAt: now.toISOString(),
  };
  const filePath = defaultXIngestDigestPath(profileId, dayKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function invalidateBriefingCacheFile(
  profileId: string,
  dayKey: string,
): Promise<void> {
  try {
    await unlink(defaultBriefingCacheFile(profileId, dayKey));
  } catch {
    /* missing is fine */
  }
}
