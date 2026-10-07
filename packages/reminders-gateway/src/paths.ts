import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function resolveRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "alfred") return dir;
      } catch {
        /* continue */
      }
    }
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

export function remindersPolicyPath(profileId?: string): string {
  const override = process.env.ALFRED_REMINDERS_POLICY_PATH?.trim();
  if (override) return path.resolve(override);
  const id = profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  return path.join(resolveRepoRoot(), "data", "gateway", id, "reminders-access.json");
}

export function remindersHelperRoot(): string {
  return path.join(
    resolveRepoRoot(),
    "packages",
    "reminders-gateway",
    "native",
    "RemindersHelper.app",
  );
}
