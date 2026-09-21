/**
 * Claim payload parsing — same contract as apps/iOS-client/src/lib/claim-qr.ts.
 */

export interface ClaimPayload {
  serverId: string;
  claimSecret: string;
  cloudUrl?: string;
  name?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLAIM_SECRET_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isUuid(value: string): boolean {
  return UUID.test(value.trim());
}

export function normalizeSecret(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

export function isCompleteSecret(input: string): boolean {
  return normalizeSecret(input).length === 8;
}

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch {
      out[rawKey] = rawValue;
    }
  }
  return out;
}

function fromJson(raw: string): ClaimPayload | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (json.type && json.type !== "alfred.desktop.claim") return null;
  const serverId = (json.serverId ?? json.desktopClientId) as string | undefined;
  const claimSecret = json.claimSecret as string | undefined;
  if (typeof serverId !== "string" || typeof claimSecret !== "string") return null;
  return build(serverId, claimSecret, json.cloudUrl as string, json.name as string);
}

function fromUri(raw: string): ClaimPayload | null {
  const q = raw.indexOf("?");
  if (q === -1) return null;
  const head = raw.slice(0, q).toLowerCase();
  if (!/(^|[:/])claim\/?$/.test(head)) return null;

  const params = parseQuery(raw.slice(q + 1));
  const serverId = params.serverId ?? params.desktopClientId;
  const claimSecret = params.claimSecret ?? params.secret;
  if (!serverId || !claimSecret) return null;
  return build(serverId, claimSecret, params.cloudUrl, params.name);
}

function build(
  serverId: string,
  claimSecret: string,
  cloudUrl?: string,
  name?: string,
): ClaimPayload | null {
  const id = serverId.trim();
  const secret = normalizeSecret(claimSecret);
  if (!isUuid(id) || secret.length < 8) return null;
  return {
    serverId: id,
    claimSecret: secret,
    cloudUrl: cloudUrl?.trim() || undefined,
    name: name?.trim() || undefined,
  };
}

export function parseClaimPayload(raw: string): ClaimPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return fromJson(trimmed);
  return fromUri(trimmed);
}
