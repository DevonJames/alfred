import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "data"]);
const MD_EXT = new Set([".md", ".mdx"]);

export interface WalkedMarkdown {
  absPath: string;
  relPath: string;
}

export async function walkMarkdownFiles(root: string): Promise<WalkedMarkdown[]> {
  const resolved = path.resolve(root);
  const out: WalkedMarkdown[] = [];
  await walk(resolved, resolved, out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function walk(root: string, dir: string, out: WalkedMarkdown[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(root, abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!MD_EXT.has(ext)) continue;
    out.push({
      absPath: abs,
      relPath: path.relative(root, abs).split(path.sep).join("/"),
    });
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
