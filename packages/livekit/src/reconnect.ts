/** Backoff for LiveKitRoomSession auto-rejoin after Mac sleep / network drops. */
export const LIVEKIT_RECONNECT_DELAYS_MS = [250, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

/** Give LiveKit's built-in reconnect a chance before we tear down and remint. */
export const LIVEKIT_NATIVE_RECONNECT_GRACE_MS = 20_000;

export function nextReconnectDelayMs(attemptZeroBased: number): number {
  const i = Math.min(Math.max(0, attemptZeroBased), LIVEKIT_RECONNECT_DELAYS_MS.length - 1);
  return LIVEKIT_RECONNECT_DELAYS_MS[i]!;
}
