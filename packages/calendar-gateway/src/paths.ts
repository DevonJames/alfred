import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Walk up from cwd to the monorepo root (package name "alfred"). */
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

export function calendarPolicyPath(profileId?: string): string {
  const override = process.env.ALFRED_CALENDAR_POLICY_PATH?.trim();
  if (override) return path.resolve(override);
  const id = profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  return path.join(resolveRepoRoot(), "data", "gateway", id, "calendar-access.json");
}

export function calendarHelperRoot(): string {
  return path.join(
    resolveRepoRoot(),
    "packages",
    "calendar-gateway",
    "native",
    "CalendarHelper.app",
  );
}
