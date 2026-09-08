/** Backoff for LiveKitRoomSession auto-rejoin after Mac sleep / network drops. */
export const LIVEKIT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

export function nextReconnectDelayMs(attemptZeroBased: number): number {
  const i = Math.min(Math.max(0, attemptZeroBased), LIVEKIT_RECONNECT_DELAYS_MS.length - 1);
  return LIVEKIT_RECONNECT_DELAYS_MS[i]!;
}
