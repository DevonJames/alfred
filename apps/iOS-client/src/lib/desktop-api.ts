/**
 * Desktop host client (PRD §8.5, §9, §11.2).
 *
 * Carries the *device* bearer in Authorization. When the active path is the
 * relay, the cloud token rides in X-Cloud-Token — Authorization stays reserved
 * for the device token end to end (§18.6).
 *
 * On a transport-level failure this rediscovers once and retries, so the app
 * survives the Mac changing networks without the user doing anything.
 */
import { ApiError, describeFailure } from "./cloud-api";
import { desktopContext, useConnection } from "./connection";
import { isPathFailure, rediscover } from "./discovery";
import type {
  AskAnswer,
  ConversationTurn,
  DesktopSettings,
  ForgetScope,
  Memory,
  MemoryKind,
  ProvenanceChain,
  PublicCandidate,
  RebuildReport,
  Reminder,
  SessionEvent,
  SessionToken,
  TurnResponse,
  VerifyReport,
} from "./types";

export { ApiError };

interface Options {
  method?: string;
  body?: unknown;
  form?: FormData;
  query?: Record<string, string | number | undefined>;
  /** Set false for the retry pass so one failure can't loop. */
  retry?: boolean;
}

function buildUrl(baseUrl: string, path: string, query?: Options["query"]): string {
  const url = `${baseUrl}${path}`;
  if (!query) return url;
  const params = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return params.length ? `${url}?${params.join("&")}` : url;
}

async function call<T>(path: string, options: Options = {}): Promise<T> {
  const context = desktopContext();
  if (!context) {
    throw new ApiError("not_connected", "This phone hasn't found your Mac yet.", 0);
  }

  const { method = "GET", body, form, query, retry = true } = options;
  const headers: Record<string, string> = {};
  if (context.deviceToken) headers.Authorization = `Bearer ${context.deviceToken}`;
  if (context.cloudToken) headers["X-Cloud-Token"] = `Bearer ${context.cloudToken}`;
  // FormData sets its own multipart boundary; setting Content-Type breaks it.
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(buildUrl(context.baseUrl, path, query), {
      method,
      headers,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (err) {
    if (retry) return retryAfterRediscovery<T>(path, options);
    useConnection.getState().setMode("offline", "Lost the connection to your Mac.");
    throw new ApiError("network_error", (err as Error).message || "Could not reach your Mac", 0);
  }

  // Read as text first: the relay hub and the desktop both answer some failures
  // in plain text, and a swallowed body means a useless error message.
  const raw = response.status === 204 ? "" : await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const [code, message] = describeFailure(parsed, raw, response.status);
    if (retry && isPathFailure(code, response.status)) {
      return retryAfterRediscovery<T>(path, options);
    }
    if (response.status === 401) {
      // Two different 401s meet here. The relay hub rejects an expired *cloud*
      // session before the desktop is ever reached — dropping the pairing over
      // that would be wrong, and would make the user re-pair for no reason.
      const fromRelayHub = code === "unauthorized" && context.baseUrl.includes("/proxy/");
      if (fromRelayHub) {
        throw new ApiError(
          "cloud_unauthorized",
          "Your alfrd.net session has expired. Sign in again to reach your Mac through the relay.",
          401
        );
      }
      // Otherwise the desktop itself no longer honours this bearer.
      if (context.deviceToken) await useConnection.getState().unpairDevice();
    }
    throw new ApiError(code, message, response.status);
  }

  useConnection.getState().setMode(useConnection.getState().mode, null);
  if (!raw) return undefined as T;

  const envelope = parsed as { data?: unknown } | null;
  return ((envelope && typeof envelope === "object" && "data" in envelope
    ? envelope.data
    : parsed) ?? null) as T;
}

async function retryAfterRediscovery<T>(path: string, options: Options): Promise<T> {
  try {
    await rediscover();
  } catch {
    useConnection.getState().setMode("offline", "Your Mac isn't reachable right now.");
    throw new ApiError("desktop_unreachable", "Your Mac isn't reachable right now.", 0);
  }
  return call<T>(path, { ...options, retry: false });
}

/** Absolute URL for an artifact or TTS clip on the current path. */
export function assetUrl(path: string | null | undefined): string | null {
  const context = desktopContext();
  if (!context || !path) return null;
  return path.startsWith("http") ? path : `${context.baseUrl}${path}`;
}

export function assetHeaders(): Record<string, string> {
  const context = desktopContext();
  if (!context) return {};
  const headers: Record<string, string> = {};
  if (context.deviceToken) headers.Authorization = `Bearer ${context.deviceToken}`;
  if (context.cloudToken) headers["X-Cloud-Token"] = `Bearer ${context.cloudToken}`;
  return headers;
}

/**
 * The Mac answers, but this feature isn't in its build yet.
 *
 * The desktop client currently ships connectivity only — pairing and the memory
 * HTTP surface are explicit follow-ons. That is a different thing from "your Mac
 * is unreachable", and the UI must not blame the network for it.
 */
export function isNotBuiltYet(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501);
}

/**
 * One sentence the user can act on. `whenUnreachable` is the screen's own
 * phrasing for a dead path; everything else is described accurately rather than
 * collapsed into "something went wrong".
 */
export function desktopErrorMessage(error: unknown, whenUnreachable: string): string {
  if (isNotBuiltYet(error)) {
    return "Your Mac is connected, but this part of Alfred isn't in its build yet. It arrives with the desktop's memory update.";
  }
  if (error instanceof ApiError) {
    if (error.status === 0 || error.code === "desktop_unreachable") return whenUnreachable;
    if (error.code === "cloud_unauthorized") return error.message;
    if (error.status === 401 || error.status === 403) {
      return "Your Mac turned this phone away. You may need to pair it again from Settings.";
    }
    return error.message;
  }
  return whenUnreachable;
}

// ---------------------------------------------------------------------------
// Pairing — runs before a device token exists, so it takes an explicit base URL
// ---------------------------------------------------------------------------

export interface DesktopInfo {
  desktopClientId: string;
  desktopClientName: string;
  claimSecret: string | null;
  relayConnected: boolean;
  cloudUrl: string | null;
}

/**
 * `GET /connect/info` on the desktop client — unauthenticated, and the only
 * place the claim secret is ever readable. It returns product names alongside
 * the control plane's `serverId` / `serverName` aliases; we accept either, and
 * either a bare body or a `{ data }` envelope.
 *
 * The secret is used once, in memory, to claim the Mac. It is never persisted
 * and never logged.
 */
export async function fetchDesktopInfo(
  baseUrl: string,
  cloudToken?: string | null
): Promise<DesktopInfo> {
  const url = `${baseUrl.replace(/\/$/, "")}/connect/info`;
  const headers: Record<string, string> = {};
  if (baseUrl.includes("/proxy/") && cloudToken) headers["X-Cloud-Token"] = `Bearer ${cloudToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    throw new ApiError("unreachable", (err as Error).message || "No answer from that address", 0);
  } finally {
    clearTimeout(timer);
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    throw new ApiError(
      (payload?.error as string) ?? "probe_failed",
      (payload?.message as string) ?? `That address answered with ${response.status}`,
      response.status
    );
  }

  const info = ((payload.data as Record<string, unknown>) ?? payload) as Record<string, unknown>;
  const id = (info.desktopClientId ?? info.serverId) as string | undefined;
  if (!id) {
    throw new ApiError("not_a_desktop", "That address answered, but it isn't an Alfred desktop.", 0);
  }

  return {
    desktopClientId: id,
    desktopClientName: ((info.desktopClientName ?? info.serverName) as string) || "Alfred",
    claimSecret: (info.claimSecret as string) ?? null,
    relayConnected: Boolean(info.relayConnected),
    cloudUrl: (info.cloudUrl as string) ?? null,
  };
}

async function pairCall<T>(baseUrl: string, path: string, body: unknown, cloudToken: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (baseUrl.includes("/proxy/") && cloudToken) headers["X-Cloud-Token"] = `Bearer ${cloudToken}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const [code, message] = describeFailure(parsed, raw, response.status);
    throw new ApiError(code === "request_failed" ? "pair_failed" : code, message, response.status);
  }

  const envelope = parsed as { data?: unknown } | null;
  return (envelope && typeof envelope === "object" && "data" in envelope
    ? envelope.data
    : parsed) as T;
}

/**
 * The pairing contract is snake_case (§6.3) while the rest of the desktop
 * surface is camel. Rather than pick a side, requests are sent exactly as
 * documented and responses are read either way — a desktop that answers in
 * camelCase still pairs.
 */
function pick<T>(body: Record<string, unknown>, ...names: string[]): T | undefined {
  for (const name of names) {
    if (body[name] !== undefined && body[name] !== null) return body[name] as T;
  }
  return undefined;
}

export async function requestPairing(
  baseUrl: string,
  deviceName: string,
  cloudToken: string | null,
  appVersion = "1.0.0"
): Promise<{ deviceId: string; expiresInSeconds: number; devPin?: string; autoPaired: boolean }> {
  const raw = await pairCall<Record<string, unknown>>(
    baseUrl,
    "/pair/request",
    { device: { name: deviceName, device_type: "ios", app_version: appVersion } },
    cloudToken
  );
  const body = raw ?? {};
  const deviceId = pick<string>(body, "device_id", "deviceId");
  if (!deviceId) {
    throw new ApiError("pair_failed", "Your Mac started pairing but didn't say which device.", 0);
  }
  return {
    deviceId,
    expiresInSeconds: pick<number>(body, "expires_in_seconds", "expiresInSeconds") ?? 300,
    // Some hosts echo the PIN for their own display; a real Mac shows it there,
    // not here, so it is only ever surfaced as a sandbox affordance.
    devPin: pick<string>(body, "pin", "devPin"),
    autoPaired: Boolean(pick<boolean>(body, "auto_paired", "autoPaired")),
  };
}

export async function confirmPairing(
  baseUrl: string,
  deviceId: string,
  pin: string,
  cloudToken: string | null
): Promise<{ deviceId: string; deviceToken: string; profileId: string; serverName: string }> {
  const raw = await pairCall<Record<string, unknown>>(
    baseUrl,
    "/pair/confirm",
    { device_id: deviceId, pin: pin.trim() },
    cloudToken
  );
  const body = raw ?? {};
  const token = pick<string>(body, "token", "deviceToken", "device_token");
  if (!token) {
    throw new ApiError("pair_failed", "Your Mac accepted the PIN but didn't issue a key.", 0);
  }
  return {
    deviceId: pick<string>(body, "device_id", "deviceId") ?? deviceId,
    deviceToken: token,
    // Not in the documented response; the desktop's own settings supply it once
    // the connection is authenticated, so an absent value is not a failure.
    profileId: pick<string>(body, "profileId", "profile_id") ?? "",
    serverName: pick<string>(body, "server_name", "serverName") ?? "Alfred",
  };
}

/** §6.3: unpairing is a DELETE on this phone's device id. */
export function revokePairing() {
  const deviceId = useConnection.getState().deviceId;
  if (!deviceId) return Promise.resolve();
  return call<void>(`/pair/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Session + conversation (§9)
// ---------------------------------------------------------------------------

/**
 * Mint a join token. The desktop answers `{ url, room, identity, token }` when
 * LiveKit is configured, and the voice guide is explicit that the transport is
 * decided by what came back — the presence of a URL and a token — rather than
 * by any field the client hopes to find (§10).
 */
export function sessionToken(mode: "voice" | "text" = "voice") {
  return call<Record<string, unknown>>("/api/session/token", {
    method: "POST",
    body: { mode },
  }).then((body): SessionToken => {
    const url = pick<string>(body, "url", "livekitUrl", "livekit_url") ?? null;
    const token = pick<string>(body, "token", "accessToken", "access_token") ?? null;
    return {
      ...(body as unknown as SessionToken),
      sessionId: String(pick<string>(body, "sessionId", "session_id", "room") ?? ""),
      room: String(pick<string>(body, "room", "roomName", "room_name") ?? ""),
      identity: String(pick<string>(body, "identity", "participantIdentity") ?? ""),
      url,
      token,
      transport: url && token ? "livekit" : "http-capture",
    };
  });
}

export interface SessionStatus {
  /** Null when the desktop build predates the LiveKit status fields. */
  livekitConfigured: boolean | null;
  room: string | null;
  /** e.g. "Run `pnpm voice` on the Mac so alfred-agent joins the LiveKit room." */
  agentHint: string | null;
  sessionId: string | null;
  state: string | null;
}

export function sessionStatus() {
  return call<Record<string, unknown>>("/api/session/status").then(
    (body): SessionStatus => ({
      livekitConfigured:
        typeof body.livekitConfigured === "boolean"
          ? body.livekitConfigured
          : typeof body.livekit_configured === "boolean"
            ? (body.livekit_configured as boolean)
            : null,
      room: pick<string>(body, "room", "roomName", "room_name") ?? null,
      agentHint: pick<string>(body, "agentHint", "agent_hint") ?? null,
      sessionId: pick<string>(body, "sessionId", "session_id") ?? null,
      state: pick<string>(body, "state") ?? null,
    })
  );
}

export function endSession(sessionId?: string) {
  return call<{ ended: boolean }>("/api/session/end", { method: "POST", body: { sessionId } });
}

export function interruptSession(reason = "user_barge_in") {
  return call<{ acknowledged: boolean }>("/api/session/interrupt", {
    method: "POST",
    body: { reason },
  });
}

export function sendTurn(text: string, opts: { sessionId?: string; source?: "voice" | "text" } = {}) {
  return call<TurnResponse>("/api/conversation/turn", {
    method: "POST",
    body: {
      text,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      source: opts.source ?? "text",
      sessionId: opts.sessionId,
    },
  });
}

/*
 * There is deliberately no audio-upload turn here. Spoken input goes over the
 * LiveKit room to the agent on the Mac (see src/lib/voice/) — uploading a clip
 * to the desktop is not a route that exists, and not the architecture.
 */

export function conversationEvents(since: number, sessionId?: string) {
  return call<{
    sessionId: string | null;
    state: string;
    events: SessionEvent[];
    cursor: number;
  }>("/api/conversation/events", { query: { since, sessionId } });
}

export function transcript(sessionId?: string) {
  return call<{ sessionId: string | null; turns: ConversationTurn[] }>(
    "/api/conversation/transcript",
    { query: { sessionId } }
  );
}

export function reportHeard(turnId: string) {
  return call<void>("/api/conversation/heard", { method: "POST", body: { turnId } });
}

// ---------------------------------------------------------------------------
// Memory (§11.2)
// ---------------------------------------------------------------------------

/**
 * The desktop's memory API is new and its field naming isn't settled — the
 * pairing routes already speak snake_case while the rest is camel. An id that
 * doesn't survive the trip is the expensive one: it breaks the link to the
 * detail screen and turns "mark done" into PATCH /api/memory/undefined. So read
 * the plausible spellings and guarantee the shape the screens rely on.
 */
function normalizeMemory(raw: unknown): Memory {
  const body = (raw ?? {}) as Record<string, unknown>;
  const array = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

  return {
    ...(body as unknown as Memory),
    // `recordId` and `memoryId` are the same DID as `id`; /api/memory/due sends
    // all three, older builds sent only recordId.
    id: String(
      pick<string>(body, "id", "memoryId", "memory_id", "recordId", "record_id", "uuid") ?? ""
    ),
    title: String(pick<string>(body, "title", "name", "text", "summary") ?? "Untitled"),
    summary: String(pick<string>(body, "summary") ?? ""),
    needsResolution: array(body.needsResolution ?? body.needs_resolution),
    artifacts: array(body.artifacts),
    assertions: array(body.assertions),
    related: array(body.related),
    reminder: normalizeReminder(body),
    overdue: Boolean(pick(body, "overdue", "is_overdue")),
  };
}

/**
 * A memory package nests its reminder; /api/memory/due flattens it, putting
 * `dueAt` / `remindAt` / `dateOnly` on the record itself. Both have to end up
 * as the same object, or Brief renders due rows with no date on them.
 */
function normalizeReminder(body: Record<string, unknown>): Reminder | null {
  const nested = body.reminder as Record<string, unknown> | null | undefined;
  const source = nested ?? body;
  const dueAt = pick<string>(source, "dueAt", "due_at", "remindAt", "remind_at");
  // No nested object and no date means this simply isn't a reminder.
  if (!nested && !dueAt) return null;

  return {
    // Only a nested object is safe to spread; the flat form would drag the
    // whole memory record's fields in with it.
    ...((nested ?? {}) as unknown as Reminder),
    timezone: String(pick<string>(source, "timezone") ?? ""),
    dueAt: dueAt ?? "",
    dateOnly: Boolean(pick(source, "dateOnly", "date_only")),
    status: (pick<Reminder["status"]>(source, "status") ?? "pending") as Reminder["status"],
    snoozedUntil: pick<string>(source, "snoozedUntil", "snoozed_until") ?? null,
    surfacedAt: pick<string>(source, "surfacedAt", "surfaced_at") ?? null,
  };
}

const normalizeMemories = (raw: unknown): Memory[] =>
  Array.isArray(raw) ? raw.map(normalizeMemory) : [];

export function addMemory(text: string, sourceKind: "voice" | "text" | "artifact" | "share" = "text") {
  return call<{ memory: Memory; createdEntities: { id: string; title: string }[]; durable: boolean }>(
    "/api/memory",
    {
      method: "POST",
      body: { text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, sourceKind },
    }
  ).then((result) => ({ ...result, memory: normalizeMemory(result.memory) }));
}

export function addMemoryWithFiles(
  text: string,
  files: { uri: string; name: string; mimeType: string }[]
) {
  const form = new FormData();
  form.append("text", text);
  form.append("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
  form.append("sourceKind", "artifact");
  for (const file of files) {
    form.append("files", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  }
  return call<{ memory: Memory; createdEntities: { id: string; title: string }[]; durable: boolean }>(
    "/api/memory",
    { method: "POST", form }
  ).then((result) => ({ ...result, memory: normalizeMemory(result.memory) }));
}

export function searchMemory(query: string, opts: { limit?: number; kinds?: MemoryKind[] } = {}) {
  return call<{ interpretedAs: string; results: Memory[] }>("/api/memory/search", {
    method: "POST",
    body: { query, limit: opts.limit ?? 20, kinds: opts.kinds },
  }).then((result) => ({ ...result, results: normalizeMemories(result.results) }));
}

export function askMemory(query: string) {
  return call<AskAnswer>("/api/memory/ask", {
    method: "POST",
    body: { query, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
}

export function correctMemory(memoryId: string, correction: string, assertionId?: string) {
  return call<{
    memory: Memory;
    newAssertionId: string;
    supersededAssertionId: string | null;
    revision: number;
  }>("/api/memory/correct", {
    method: "POST",
    body: {
      memoryId,
      correction,
      assertionId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  }).then((result) => ({ ...result, memory: normalizeMemory(result.memory) }));
}

export function forgetMemory(id: string, scope: ForgetScope) {
  return call<{ id: string; scope: ForgetScope; removed: Record<string, number>; kept: string[] }>(
    `/api/memory/${encodeURIComponent(id)}`,
    { method: "DELETE", query: { scope } }
  );
}

export function recentMemories(limit = 20) {
  return call<{ memories: Memory[] }>("/api/memory/recent", { query: { limit } }).then(
    (result) => ({ memories: normalizeMemories(result.memories) })
  );
}

export function getEntity(id: string) {
  return call<{ memory: Memory }>(`/api/memory/entity/${encodeURIComponent(id)}`).then(
    (result) => ({ memory: normalizeMemory(result.memory) })
  );
}

export function getEpisode(id: string) {
  return call<{ memory: Memory }>(`/api/memory/episode/${encodeURIComponent(id)}`).then(
    (result) => ({ memory: normalizeMemory(result.memory) })
  );
}

export function getProvenance(assertionId: string) {
  return call<ProvenanceChain>(
    `/api/memory/assertion/${encodeURIComponent(assertionId)}/provenance`
  );
}

export function resolveAmbiguity(memoryId: string, field: string, answer: string) {
  return call<{ memory: Memory }>(`/api/memory/${encodeURIComponent(memoryId)}/resolve`, {
    method: "POST",
    body: { field, answer },
  }).then((result) => ({ memory: normalizeMemory(result.memory) }));
}

export function dueReminders(date?: string) {
  return call<{ date: string; timezone: string; reminders: Memory[] }>("/api/memory/due", {
    query: { date, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  }).then((result) => ({ ...result, reminders: normalizeMemories(result.reminders) }));
}

export function markReminderSurfaced(id: string) {
  return call<{ id: string; surfacedAt: string }>(
    `/api/memory/${encodeURIComponent(id)}/reminder/surfaced`,
    { method: "POST" }
  );
}

export function setReminderStatus(
  id: string,
  status: "completed" | "dismissed" | "snoozed" | "pending",
  snoozedUntil?: string
) {
  return call<{ id: string; status: string; revisionUnchanged: boolean }>(
    `/api/memory/${encodeURIComponent(id)}/reminder/status`,
    { method: "POST", body: { status, snoozedUntil } }
  );
}

export function verifyMemory() {
  return call<VerifyReport>("/api/memory/verify", { method: "POST" });
}

export function rebuildIndexes() {
  return call<RebuildReport>("/api/memory/rebuild-indexes", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Public knowledge (§11.2) — recommendations, never "Alfred remembers this"
// ---------------------------------------------------------------------------

export function indexPublic(url: string) {
  return call<{ item: PublicCandidate; deduped: boolean }>("/api/public-knowledge/index", {
    method: "POST",
    body: { url },
  });
}

export function discoverPublic(limit = 5) {
  return call<{ kind: string; disclaimer: string; candidates: PublicCandidate[] }>(
    "/api/public-knowledge/discover",
    { method: "POST", body: { limit } }
  );
}

/** Saves a recommendation into private memory. Nothing leaves the desktop. */
export function linkPublic(publicItemId: string, note?: string) {
  return call<{ memory: Memory }>("/api/memory/link-public", {
    method: "POST",
    body: { publicItemId, note },
  }).then((result) => ({ memory: normalizeMemory(result.memory) }));
}

/** `confirm` is a literal true on the wire: publishing is never implicit (§11.5). */
export function publishPublic(memoryId: string) {
  return call<{ published: boolean; url?: string }>("/api/public-knowledge/publish", {
    method: "POST",
    body: { memoryId, confirm: true },
  });
}

// ---------------------------------------------------------------------------
// Settings (§12.4)
// ---------------------------------------------------------------------------

export function getSettings() {
  return call<{ settings: DesktopSettings }>("/api/settings");
}

export function patchSettings(patch: {
  privacyMode?: DesktopSettings["privacyMode"];
  voiceMode?: DesktopSettings["voiceMode"];
}) {
  return call<{ settings: DesktopSettings }>("/api/settings", { method: "PATCH", body: patch });
}
