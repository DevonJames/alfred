/**
 * alfrd.net control plane client.
 *
 * Accountless: prove Desktop Client ID + claim secret → scoped link JWT.
 * That JWT is used for candidates + X-Cloud-Token on the relay.
 * Device bearers belong to desktop-api.ts and must never be sent here.
 */
import type { Candidate, DesktopSummary } from "./types";

export const CLOUD_BASE = (
  process.env.EXPO_PUBLIC_CLOUD_URL ??
  process.env.EXPO_PUBLIC_ALFRD_CLOUD_URL ??
  "https://api.alfrd.net"
).replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ZodIssue {
  path: (string | number)[];
  message: string;
}

export function describeFailure(parsed: unknown, raw: string, status: number): [string, string] {
  const body = parsed as
    | { error?: unknown; message?: string; detail?: unknown; success?: boolean }
    | null
    | undefined;
  const error = body?.error;

  if (error && typeof error === "object") {
    const issues = (error as { issues?: ZodIssue[] }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const detail = issues
        .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message.toLowerCase()}`)
        .join(", ");
      return ["invalid_request", detail];
    }
  }

  if (typeof error === "string") return [error, body?.message ?? error];
  if (body?.message) return ["request_failed", body.message];
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail) return ["request_failed", detail];

  const text = raw.trim();
  if (text && text.length < 200 && !text.startsWith("<")) return ["request_failed", text];
  return ["request_failed", `Request failed (${status})`];
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string | null } = {}
): Promise<T> {
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
    throw new ApiError("network_error", (err as Error).message || "Could not reach alfrd.net", 0);
  }

  const raw = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const [code, message] = describeFailure(parsed, raw, response.status);
    throw new ApiError(code, message, response.status);
  }

  if (response.status === 204 || !raw) return undefined as T;

  const body = parsed as { data?: unknown } | null;
  return ((body && typeof body === "object" && "data" in body ? body.data : parsed) ?? null) as T;
}

function listFrom<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const wrapped = (raw as Record<string, unknown> | null)?.[key];
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export interface LinkResult {
  token: string;
  expiresAt?: string;
  serverId: string;
  name: string;
  connectionCandidates: Candidate[];
  lastSeen: string | null;
}

/** Prove claim secret → link JWT. No user account. */
export async function linkDesktop(serverId: string, claimSecret: string): Promise<LinkResult> {
  const raw = await request<Record<string, unknown>>("/servers/link", {
    method: "POST",
    body: JSON.stringify({
      serverId: serverId.trim(),
      claimSecret: claimSecret.trim().toUpperCase(),
    }),
  });

  const token = (raw.token as string) ?? "";
  if (!token) {
    throw new ApiError("no_token", "alfrd.net linked the Mac but didn't return a token.", 200);
  }

  const candidates = listFrom<Candidate>(raw.connectionCandidates ?? raw.candidates, "candidates");

  return {
    token,
    expiresAt: raw.expiresAt as string | undefined,
    serverId: (raw.serverId as string) ?? serverId.trim(),
    name: (raw.name as string) ?? "Alfred",
    connectionCandidates: candidates,
    lastSeen: (raw.lastSeen as string) ?? null,
  };
}

/** @deprecated use linkDesktop */
export function claimDesktop(_token: string, serverId: string, claimSecret: string) {
  return linkDesktop(serverId, claimSecret);
}

export async function getCandidates(
  token: string,
  serverId: string
): Promise<{ serverId: string; candidates: Candidate[] }> {
  const raw = await request<unknown>(`/servers/${encodeURIComponent(serverId)}/candidates`, {
    token,
  });
  const body = (raw ?? {}) as Record<string, unknown>;
  const candidates = listFrom<Candidate>(
    body.candidates ?? body.connectionCandidates,
    "candidates"
  );
  return { serverId, candidates };
}

export function unlinkDesktop(token: string, serverId: string) {
  return request<void>(`/servers/${encodeURIComponent(serverId)}`, { method: "DELETE", token });
}

/** Best-effort single-desktop summary from a live link token. */
export async function linkedDesktop(
  token: string,
  serverId: string
): Promise<DesktopSummary | null> {
  try {
    const { candidates } = await getCandidates(token, serverId);
    return {
      serverId,
      name: "Alfred",
      claimedAt: null,
      lastSeenAt: "",
      online: candidates.length > 0,
    };
  } catch {
    return null;
  }
}
