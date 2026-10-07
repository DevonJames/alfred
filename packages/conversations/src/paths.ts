import { existsSync } from "node:fs";
import path from "node:path";

/** Walk up from cwd looking for the monorepo root (pnpm-workspace.yaml). */
export function resolveRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

export function defaultConversationsDir(profileId?: string, dir?: string): string {
  const id = (profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default").trim() || "profile.default";
  const base =
    dir?.trim() ||
    process.env.ALFRED_CONVERSATIONS_DIR?.trim() ||
    path.join(resolveRepoRoot(), "data", "conversations", id);
  return path.resolve(base);
}

export const IDLE_MERGE_MS = 30 * 60_000;
