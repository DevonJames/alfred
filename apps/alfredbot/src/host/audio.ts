export type AudioSource = "phone" | "local";

export function parseAudioSource(value: unknown): AudioSource | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().toLowerCase();
  if (clean === "local") return "local";
  if (clean === "phone") return "phone";
  return null;
}

/**
 * Phone audio is the default — the Pi's own driver has been unreliable.
 * A stored choice (from the iPhone) wins over ALFREDBOT_AUDIO.
 */
export function resolveAudioSource(
  stored?: string | null,
  env = process.env.ALFREDBOT_AUDIO,
): AudioSource {
  return parseAudioSource(stored) ?? (parseAudioSource(env) === "local" ? "local" : "phone");
}
