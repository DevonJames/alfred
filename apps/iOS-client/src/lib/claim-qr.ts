/**
 * Claim payload parsing (§4 "Claim via QR").
 *
 * The desktop shows one QR code containing a deep link:
 *
 *   alfred://claim?v=1&serverId=<uuid>&claimSecret=<8CHAR>&cloudUrl=…&name=Alfred
 *
 * Some tools embed the equivalent JSON instead, and the same link can arrive
 * through iOS as a cold-start or warm deep link. All three routes end up here.
 *
 * Deliberately hand-rolled rather than using `URL`: React Native's URL shim
 * does not implement `searchParams`, and a custom scheme like `alfred:` is not
 * parsed as hierarchical by every engine. Splitting the query string myself is
 * boring and works everywhere.
 */

export interface ClaimPayload {
  serverId: string;
  claimSecret: string;
  /** Advisory only — the app's configured control plane wins (§4.2). */
  cloudUrl?: string;
  name?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The desktop's alphabet excludes I, O, 0 and 1 so the secret can be read aloud. */
export const CLAIM_SECRET_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isUuid(value: string): boolean {
  return UUID.test(value.trim());
}

/**
 * Normalize what the user typed: the secret is printed uppercase, and spaces or
 * dashes someone adds while reading it aloud aren't part of it. No character is
 * substituted — I, O, 0 and 1 are absent from the alphabet precisely so they
 * never need guessing at, and silently rewriting one would hide a real misread.
 */
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

/** Characters the desktop never prints — a sign the code was misread. */
export function suspectCharacters(input: string): string[] {
  return [...new Set([...normalizeSecret(input)].filter((c) => !CLAIM_SECRET_ALPHABET.includes(c)))];
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
  // `type` is checked when present, but a payload carrying both fields is
  // unmistakable — refusing it over a missing label helps nobody.
  if (json.type && json.type !== "alfred.desktop.claim") return null;
  const serverId = (json.serverId ?? json.desktopClientId) as string | undefined;
  const claimSecret = json.claimSecret as string | undefined;
  if (typeof serverId !== "string" || typeof claimSecret !== "string") return null;
  return build(serverId, claimSecret, json.cloudUrl as string, json.name as string);
}

/**
 * Accept any scheme whose path is `claim`: the desktop encodes `alfred://`,
 * but this build registers its own scheme and a universal link would arrive as
 * `https://alfrd.net/claim?…`. The query is what matters.
 */
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
  name?: string
): ClaimPayload | null {
  const id = serverId.trim();
  const secret = normalizeSecret(claimSecret);
  // A malformed code is worse than no code: it would send a doomed claim to the
  // control plane and blame the user for the 404 that comes back.
  if (!isUuid(id) || secret.length < 8) return null;
  return {
    serverId: id,
    claimSecret: secret,
    cloudUrl: cloudUrl?.trim() || undefined,
    name: name?.trim() || undefined,
  };
}

/** Returns null for anything that isn't an Alfred claim code. */
export function parseClaimPayload(raw: string): ClaimPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return fromJson(trimmed);
  return fromUri(trimmed);
}
