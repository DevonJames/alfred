/** Identifies Alfred on public feeds that require a User-Agent (NWS). */
export const ALFRED_FEED_USER_AGENT = "Alfred/0.1 (personal voice assistant)";

export async function fetchJson(
  url: string,
  opts?: { timeoutMs?: number; accept?: string },
): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: opts?.accept ?? "application/json",
        "User-Agent": ALFRED_FEED_USER_AGENT,
      },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 8_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
