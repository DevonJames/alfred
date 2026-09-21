export const CLOUD_BASE = (
  process.env.ALFREDBOT_CLOUD_URL ??
  process.env.ALFRD_CLOUD_URL ??
  "https://api.alfrd.net"
).replace(/\/$/, "");

export interface Candidate {
  type: "lan" | "wan" | "relay";
  url: string;
  priority: number;
}

export interface LinkResult {
  token: string;
  serverId: string;
  name: string;
  connectionCandidates: Candidate[];
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code = "request_failed",
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

function listCandidates(raw: unknown): Candidate[] {
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as { candidates?: unknown; connectionCandidates?: unknown }).connectionCandidates ??
        (raw as { candidates?: unknown }).candidates)
      : [];
  if (!Array.isArray(source)) return [];
  return source
    .map((item) => {
      const row = item as Partial<Candidate>;
      if (!row || (row.type !== "lan" && row.type !== "wan" && row.type !== "relay")) return null;
      if (typeof row.url !== "string" || !row.url) return null;
      return {
        type: row.type,
        url: row.url.replace(/\/$/, ""),
        priority: typeof row.priority === "number" ? row.priority : 100,
      };
    })
    .filter((row): row is Candidate => row !== null);
}

async function cloudFetch<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const { token, headers, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${CLOUD_BASE}${path}`, {
      ...rest,
      headers: {
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch (err) {
    throw new CloudApiError((err as Error).message || "Could not reach alfrd.net", 0, "network_error");
  }

  const raw = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const body = parsed as { detail?: string; message?: string; error?: string } | null;
    throw new CloudApiError(
      body?.detail ?? body?.message ?? body?.error ?? `Request failed (${response.status})`,
      response.status,
    );
  }

  const envelope = parsed as { data?: unknown } | null;
  return ((envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : parsed) ??
    null) as T;
}

export async function linkDesktop(serverId: string, claimSecret: string): Promise<LinkResult> {
  const raw = await cloudFetch<Record<string, unknown>>("/servers/link", {
    method: "POST",
    body: JSON.stringify({
      serverId: serverId.trim(),
      claimSecret: claimSecret.trim().toUpperCase(),
    }),
  });
  const token = typeof raw.token === "string" ? raw.token : "";
  if (!token) {
    throw new CloudApiError("alfrd.net linked the Mac but did not return a token.", 200, "no_token");
  }
  return {
    token,
    serverId: typeof raw.serverId === "string" ? raw.serverId : serverId.trim(),
    name: typeof raw.name === "string" ? raw.name : "Alfred",
    connectionCandidates: listCandidates(raw.connectionCandidates ?? raw.candidates),
  };
}

export async function getCandidates(token: string, serverId: string): Promise<Candidate[]> {
  const raw = await cloudFetch<unknown>(`/servers/${encodeURIComponent(serverId)}/candidates`, {
    token,
  });
  const body = (raw ?? {}) as Record<string, unknown>;
  return listCandidates(body.candidates ?? body.connectionCandidates ?? raw);
}
