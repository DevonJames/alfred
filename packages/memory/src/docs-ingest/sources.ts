import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultDocsSourcesPath } from "./paths.js";
import type { DocsSource, DocsSourcesFile } from "./types.js";

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "docs";
}

function normalizeDir(p: string): string {
  return path.resolve(p.trim());
}

export async function loadDocsSources(
  profileId: string,
  filePath = defaultDocsSourcesPath(profileId),
): Promise<DocsSource[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as DocsSourcesFile;
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

export async function saveDocsSources(
  profileId: string,
  sources: DocsSource[],
  filePath = defaultDocsSourcesPath(profileId),
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body: DocsSourcesFile = { sources };
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function makeDocsSource(dir: string, label?: string): DocsSource {
  const resolved = normalizeDir(dir);
  const base = path.basename(resolved);
  const name = (label ?? base).trim() || base;
  return {
    id: slug(name),
    path: resolved,
    label: name,
  };
}

export async function addDocsSource(
  profileId: string,
  input: { path: string; label?: string },
): Promise<DocsSource> {
  const sources = await loadDocsSources(profileId);
  const next = makeDocsSource(input.path, input.label);
  const idx = sources.findIndex((s) => s.path === next.path);
  if (idx >= 0) {
    sources[idx] = { ...sources[idx]!, ...next, id: sources[idx]!.id };
    await saveDocsSources(profileId, sources);
    return sources[idx]!;
  }
  if (sources.some((s) => s.id === next.id)) {
    next.id = `${next.id}-${slug(path.basename(path.dirname(next.path)))}`;
  }
  sources.push(next);
  await saveDocsSources(profileId, sources);
  return next;
}

export async function removeDocsSource(
  profileId: string,
  pathOrLabel: string,
): Promise<DocsSource | undefined> {
  const sources = await loadDocsSources(profileId);
  const found = findDocsSource(sources, pathOrLabel);
  if (!found) return undefined;
  const next = sources.filter((s) => s.id !== found.id);
  await saveDocsSources(profileId, next);
  return found;
}

export function findDocsSource(sources: DocsSource[], q: string): DocsSource | undefined {
  const needle = q.trim().toLowerCase();
  const resolved = (() => {
    try {
      return path.resolve(q.trim()).toLowerCase();
    } catch {
      return needle;
    }
  })();
  return (
    sources.find((s) => s.path.toLowerCase() === resolved) ??
    sources.find((s) => s.id.toLowerCase() === needle) ??
    sources.find((s) => s.label.toLowerCase() === needle) ??
    sources.find((s) => s.label.toLowerCase().includes(needle)) ??
    sources.find((s) => s.path.toLowerCase().includes(needle))
  );
}
