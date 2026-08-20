/**
 * alfrd.net control plane client (PRD §8.3).
 *
 * This layer only ever carries the *cloud* token. Device bearers belong to
 * desktop-api.ts and must never be sent here.
 */
import type { Candidate, CloudUser, DesktopSummary } from "./types";

/**
 * The control plane is already deployed at api.alfrd.net. It is not this
 * project's backend and nothing about the phone's own state is stored there —
 * it exists only to hold the account, the desktop claim, and the relay tunnel.
 */
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

/**
 * The control plane speaks three dialects of failure: a Zod envelope
 * (`{success:false,error:{issues}}`), a bare `{error:"code"}`, and plain text
 * ("Invalid email or password"). All three carry something worth showing the
 * user, so none of them get flattened into "request failed".
 */
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
  // The desktop's pairing routes speak FastAPI's dialect: `{ detail: "…" }`.
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail) return ["request_failed", detail];

  const text = raw.trim();
  if (text && text.length < 200 && !text.startsWith("<")) return ["request_failed", text];
  return ["request_failed", `Request failed (${status})`];
}

/** Turn any failure — HTTP, network, or malformed body — into one ApiError shape. */
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

  // Some routes wrap in `{ data }`, some answer with the object directly.
  const body = parsed as { data?: unknown } | null;
  return ((body && typeof body === "object" && "data" in body ? body.data : parsed) ?? null) as T;
}

// --- account ---------------------------------------------------------------

export interface AuthResult {
  token: string;
  user: CloudUser;
}

/**
 * The token field isn't documented anywhere we can read, so accept the three
 * names it plausibly has rather than crashing on a successful sign-in.
 */
function normalizeAuth(raw: unknown, email: string): AuthResult {
  const body = (raw ?? {}) as Record<string, unknown>;
  const user = (body.user ?? {}) as Record<string, unknown>;
  const token = (body.token ?? body.accessToken ?? body.jwt ?? user.token) as string | undefined;

  if (!token) {
    throw new ApiError(
      "no_token",
      "alfrd.net accepted the sign-in but didn't return a token.",
      200
    );
  }

  return {
    token,
    user: {
      id: (user.id as string) ?? "",
      email: (user.email as string) ?? email,
      displayName: (user.displayName as string) ?? null,
    },
  };
}

export async function register(email: string, password: string, displayName: string) {
  const raw = await request<unknown>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password, displayName: displayName.trim() }),
  });
  return normalizeAuth(raw, email.trim());
}

export async function login(email: string, password: string) {
  const raw = await request<unknown>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password }),
  });
  return normalizeAuth(raw, email.trim());
}

export function me(token: string) {
  return request<{ user: CloudUser }>("/auth/me", { token });
}

export function logout(token: string) {
  return request<void>("/auth/logout", { method: "POST", token });
}

// --- desktops --------------------------------------------------------------

export function claimDesktop(token: string, serverId: string, claimSecret: string) {
  return request<{ serverId: string; name: string; claimedAt: string }>("/servers/claim", {
    method: "POST",
    token,
    // The desktop prints the secret in mixed case; the host compares case-insensitively.
    body: JSON.stringify({ serverId: serverId.trim(), claimSecret: claimSecret.trim() }),
  });
}

/** Both routes may answer with a bare array or a named wrapper; accept either. */
function listFrom<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const wrapped = (raw as Record<string, unknown> | null)?.[key];
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

export async function listDesktops(token: string): Promise<{ servers: DesktopSummary[] }> {
  const raw = await request<unknown>("/servers", { token });
  const servers = listFrom<Record<string, unknown>>(raw, "servers").map((server) => ({
    serverId: (server.serverId ?? server.id ?? server.desktopClientId) as string,
    name: (server.name ?? server.serverName ?? server.desktopClientName ?? "Alfred") as string,
    claimedAt: (server.claimedAt as string) ?? null,
    lastSeenAt: (server.lastSeenAt as string) ?? "",
    online: Boolean(server.online ?? server.relayConnected),
  }));
  return { servers: servers.filter((server) => Boolean(server.serverId)) };
}

export async function getCandidates(
  token: string,
  serverId: string
): Promise<{ serverId: string; candidates: Candidate[] }> {
  const raw = await request<unknown>(`/servers/${encodeURIComponent(serverId)}/candidates`, {
    token,
  });
  return { serverId, candidates: listFrom<Candidate>(raw, "candidates") };
}

export function unlinkDesktop(token: string, serverId: string) {
  return request<void>(`/servers/${encodeURIComponent(serverId)}`, { method: "DELETE", token });
}
