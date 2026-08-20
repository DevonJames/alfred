/**
 * Discovery ladder (PRD §8.4).
 *
 * Candidates come from the control plane already ordered by priority: LAN
 * first, then WAN, then relay. We probe them in that order and take the first
 * that answers /connect/health — a candidate that merely *resolves* is not a
 * path, only one that responds is.
 */
import { CLOUD_BASE, getCandidates } from "./cloud-api";
import { modeForUrl, useConnection } from "./connection";
import type { Candidate, ConnectionMode } from "./types";

const PROBE_TIMEOUT_MS = 5000;

/** Documented ordering, used when a candidate arrives without a priority. */
const DEFAULT_PRIORITY: Record<Candidate["type"], number> = { lan: 10, wan: 20, relay: 100 };

function rank(candidate: Candidate): number {
  return typeof candidate.priority === "number"
    ? candidate.priority
    : (DEFAULT_PRIORITY[candidate.type] ?? 1000);
}

/**
 * The relay path is a property of the control plane, not of the desktop's
 * advertisement — `/proxy/:serverId` always exists for a claimed machine. Keep
 * it as a last rung even if the candidate list forgot to mention it, so a Mac
 * that has only just come up is still reachable.
 */
function withRelayFallback(candidates: Candidate[], serverId: string): Candidate[] {
  if (candidates.some((candidate) => candidate.type === "relay")) return candidates;
  return [
    ...candidates,
    {
      type: "relay",
      url: `${CLOUD_BASE}/proxy/${encodeURIComponent(serverId)}`,
      priority: DEFAULT_PRIORITY.relay,
    },
  ];
}

export interface DiscoveryResult {
  url: string;
  mode: ConnectionMode;
  candidate: Candidate;
}

export class DiscoveryError extends Error {
  constructor(
    message: string,
    public tried: { url: string; reason: string }[]
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

async function probe(candidate: Candidate, cloudToken: string | null): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    // Relay candidates are unreachable without the account token — the hub
    // rejects them at the edge before the desktop ever sees the request.
    if (candidate.type === "relay" && cloudToken) headers["X-Cloud-Token"] = `Bearer ${cloudToken}`;

    const response = await fetch(`${candidate.url.replace(/\/$/, "")}/connect/health`, {
      headers,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race the ladder and remember the winner. Returns the chosen path; throws
 * DiscoveryError with everything it tried when no candidate answers.
 */
export async function discover(): Promise<DiscoveryResult> {
  const { cloudToken, serverId, setServerUrl, setMode, setDiscovering } = useConnection.getState();
  if (!cloudToken || !serverId) {
    throw new DiscoveryError("Not signed in, or no desktop claimed yet", []);
  }

  setDiscovering(true);
  const tried: { url: string; reason: string }[] = [];
  try {
    const { candidates } = await getCandidates(cloudToken, serverId);
    const ladder = withRelayFallback(candidates, serverId).sort((a, b) => rank(a) - rank(b));

    for (const candidate of ladder) {
      if (await probe(candidate, cloudToken)) {
        const url = candidate.url.replace(/\/$/, "");
        const mode = modeForUrl(url);
        await setServerUrl(url, mode);
        return { url, mode, candidate };
      }
      tried.push({ url: candidate.url, reason: `${candidate.type} did not answer` });
    }

    setMode("offline", "Your Mac isn't reachable on any path right now.");
    throw new DiscoveryError("No candidate answered", tried);
  } catch (err) {
    if (err instanceof DiscoveryError) throw err;
    setMode("offline", (err as Error).message);
    throw new DiscoveryError((err as Error).message, tried);
  } finally {
    setDiscovering(false);
  }
}

/**
 * Rediscovery backoff (§8.4.5). The desktop moving networks looks exactly like
 * a transient blip for the first second or two, so we retry the whole ladder a
 * few times with growing gaps rather than declaring the Mac gone on one miss.
 */
const BACKOFF_MS = [0, 1500, 4000, 10_000];
let inFlight: Promise<DiscoveryResult> | null = null;

export async function rediscover(): Promise<DiscoveryResult> {
  // Several failing requests will all ask at once; they should share one ladder.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let last: unknown;
    for (const delay of BACKOFF_MS) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        return await discover();
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new DiscoveryError("Rediscovery failed", []);
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Errors that mean "this path is dead", not "this request was bad" (§8.4.5).
 * A 502 relay_local_error is the hub telling us the tunnel dropped; a 404 on a
 * memory id is not a transport problem and must not trigger rediscovery.
 */
export function isPathFailure(code: string, status: number): boolean {
  if (status === 0) return true; // network error / timeout
  // A 5xx from the relay hop is always the tunnel, never the request body.
  if (status === 502 || status === 503 || status === 504) return true;
  return code === "relay_no_such_server" || code === "relay_local_error";
}
