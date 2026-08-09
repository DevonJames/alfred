import path from "node:path";
import { resolveRepoRoot } from "../local-provider.js";

export function defaultOipMemoryRoot(profileId: string): string {
  const fromEnv = process.env.ALFRED_MEMORY_OIP_PATH;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(resolveRepoRoot(), "data", "memory-oip", profileId);
}
