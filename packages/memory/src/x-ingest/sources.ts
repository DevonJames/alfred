import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultXSourcesPath } from "./paths.js";
import type { XSource, XSourcesFile } from "./types.js";
import { slugFromTitle } from "./urls.js";

export function archiveNoteName(note: string): string {
  return `${note} Ingested`;
}

export async function loadXSources(
  profileId: string,
  filePath = defaultXSourcesPath(profileId),
): Promise<XSource[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as XSourcesFile;
    return Array.isArray(parsed.sources) ? parsed.sources : [];
  } catch {
    return [];
  }
}

export async function saveXSources(
  profileId: string,
  sources: XSource[],
  filePath = defaultXSourcesPath(profileId),
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body: XSourcesFile = { sources };
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function makeXSource(folder: string, note: string, archiveNote?: string): XSource {
  return {
    id: slugFromTitle(note),
    folder: folder.trim(),
    note: note.trim(),
    archiveNote: (archiveNote ?? archiveNoteName(note)).trim(),
  };
}

export async function addXSource(
  profileId: string,
  input: { folder: string; note: string; archiveNote?: string },
): Promise<XSource> {
  const sources = await loadXSources(profileId);
  const next = makeXSource(input.folder, input.note, input.archiveNote);
  const idx = sources.findIndex(
    (s) =>
      s.note.toLowerCase() === next.note.toLowerCase() &&
      s.folder.toLowerCase() === next.folder.toLowerCase(),
  );
  if (idx >= 0) {
    sources[idx] = { ...sources[idx]!, ...next, id: sources[idx]!.id };
    await saveXSources(profileId, sources);
    return sources[idx]!;
  }
  if (sources.some((s) => s.id === next.id)) {
    next.id = `${next.id}-${slugFromTitle(next.folder)}`;
  }
  sources.push(next);
  await saveXSources(profileId, sources);
  return next;
}

export async function removeXSource(
  profileId: string,
  note: string,
): Promise<XSource | undefined> {
  const sources = await loadXSources(profileId);
  const idx = sources.findIndex((s) => s.note.toLowerCase() === note.trim().toLowerCase());
  if (idx < 0) return undefined;
  const [removed] = sources.splice(idx, 1);
  await saveXSources(profileId, sources);
  return removed;
}

export function findXSource(sources: XSource[], note: string): XSource | undefined {
  const q = note.trim().toLowerCase();
  return (
    sources.find((s) => s.note.toLowerCase() === q) ??
    sources.find((s) => s.id.toLowerCase() === q) ??
    sources.find((s) => s.note.toLowerCase().includes(q))
  );
}
