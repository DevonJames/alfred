import path from "node:path";
import { defaultOipMemoryRoot, defaultPersonaDir, OipLocalMemoryProvider } from "@alfred/memory";
import { isSidecarMode } from "./sidecar-mode.js";

const providers = new Map<string, OipLocalMemoryProvider>();

export function activeProfileId(override?: string): string {
  return override?.trim() || process.env.ALFRED_PROFILE_ID || "profile.default";
}

export function oipRootForProfile(profileId: string): string {
  const fromEnv = process.env.ALFRED_MEMORY_OIP_PATH?.trim();
  if (fromEnv && isSidecarMode()) {
    return path.join(path.resolve(fromEnv), profileId);
  }
  if (fromEnv) return path.resolve(fromEnv);
  return defaultOipMemoryRoot(profileId);
}

export function personaDirForProfile(profileId: string): string {
  const fromEnv = process.env.ALFRED_PERSONA_DIR?.trim();
  if (fromEnv && isSidecarMode()) {
    return path.join(path.resolve(fromEnv), profileId);
  }
  if (fromEnv) return path.resolve(fromEnv);
  return defaultPersonaDir(profileId);
}

/** Shared OIP-local provider for desktop HTTP APIs (canonical for mobile). */
export function oipForProfile(profileId?: string): OipLocalMemoryProvider {
  const id = activeProfileId(profileId);
  const existing = providers.get(id);
  if (existing) return existing;
  const created = new OipLocalMemoryProvider(oipRootForProfile(id));
  providers.set(id, created);
  return created;
}
