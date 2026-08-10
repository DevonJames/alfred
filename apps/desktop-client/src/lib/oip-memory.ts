import { defaultOipMemoryRoot, OipLocalMemoryProvider } from "@alfred/memory";

/** Shared OIP-local provider for desktop HTTP APIs (canonical for mobile). */
export function oipForProfile(profileId?: string): OipLocalMemoryProvider {
  const id = profileId ?? process.env.ALFRED_PROFILE_ID ?? "profile.default";
  return new OipLocalMemoryProvider(defaultOipMemoryRoot(id));
}

export function activeProfileId(): string {
  return process.env.ALFRED_PROFILE_ID ?? "profile.default";
}
