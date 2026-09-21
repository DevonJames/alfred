import { CLOUD_BASE, getCandidates, type Candidate } from "./cloud.js";

const PROBE_TIMEOUT_MS = 5_000;

const DEFAULT_PRIORITY: Record<Candidate["type"], number> = { lan: 10, wan: 20, relay: 100 };

export interface DiscoveryResult {
  url: string;
  mode: Candidate["type"];
}

function rank(candidate: Candidate): number {
  return typeof candidate.priority === "number"
    ? candidate.priority
    : (DEFAULT_PRIORITY[candidate.type] ?? 1000);
}

function withRelayFallback(candidates: Candidate[], serverId: string): Candidate[] {
  if (candidates.some((c) => c.type === "relay")) return candidates;
  return [
    ...candidates,
    {
      type: "relay",
      url: `${CLOUD_BASE}/proxy/${encodeURIComponent(serverId)}`,
      priority: DEFAULT_PRIORITY.relay,
    },
  ];
}

export function relayHeaders(url: string, cloudToken: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if ((url.includes("/proxy/") || url.includes("api.alfrd.net")) && cloudToken) {
    headers["X-Cloud-Token"] = `Bearer ${cloudToken}`;
  }
  return headers;
}

export async function probeHealth(url: string, cloudToken: string | null): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/connect/health`, {
      headers: relayHeaders(url, cloudToken),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverServer(
  serverId: string,
  cloudToken: string,
  seeded: Candidate[] = [],
): Promise<DiscoveryResult> {
  let candidates = seeded;
  try {
    const fresh = await getCandidates(cloudToken, serverId);
    if (fresh.length) candidates = fresh;
  } catch {
    // Use seeded candidates from the link response when refresh fails.
  }

  const ladder = withRelayFallback(candidates, serverId).sort((a, b) => rank(a) - rank(b));
  for (const candidate of ladder) {
    const url = candidate.url.replace(/\/$/, "");
    if (await probeHealth(url, cloudToken)) {
      return { url, mode: candidate.type };
    }
  }
  throw new Error("Desktop is not reachable on LAN, WAN, or relay. Is `pnpm desktop` running?");
}

export async function desktopFetch(
  baseUrl: string,
  cloudToken: string | null,
  deviceToken: string | null,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 6_000, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("Content-Type") && rest.body && !(rest.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (deviceToken) headers.set("Authorization", `Bearer ${deviceToken}`);
  const relay = relayHeaders(baseUrl, cloudToken);
  for (const [key, value] of Object.entries(relay)) headers.set(key, value);
  const url = `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (rest.signal) {
    rest.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...rest, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
