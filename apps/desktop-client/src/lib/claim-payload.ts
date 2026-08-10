/**
 * Canonical claim payload for QR + manual pairing.
 *
 * QR encodes a deep-link URI. iOS parses it, then calls
 * POST https://api.alfrd.net/servers/claim with { serverId, claimSecret }.
 */

export const CLAIM_QR_VERSION = 1;
export const CLAIM_URI_SCHEME = "alfred";
export const CLAIM_URI_HOST = "claim";

export type ClaimPayload = {
  v: typeof CLAIM_QR_VERSION;
  type: "alfred.desktop.claim";
  serverId: string;
  desktopClientId: string;
  claimSecret: string;
  cloudUrl: string;
  name: string;
  /** Deep link encoded in the QR code */
  uri: string;
};

export function buildClaimUri(input: {
  serverId: string;
  claimSecret: string;
  cloudUrl: string;
  name: string;
}): string {
  const params = new URLSearchParams({
    v: String(CLAIM_QR_VERSION),
    serverId: input.serverId,
    claimSecret: input.claimSecret.trim().toUpperCase(),
    cloudUrl: input.cloudUrl,
    name: input.name,
  });
  return `${CLAIM_URI_SCHEME}://${CLAIM_URI_HOST}?${params.toString()}`;
}

export function buildClaimPayload(input: {
  serverId: string;
  claimSecret: string;
  cloudUrl?: string;
  name?: string;
}): ClaimPayload {
  const serverId = input.serverId;
  const claimSecret = input.claimSecret.trim().toUpperCase();
  const cloudUrl = input.cloudUrl ?? process.env.ALFRD_CLOUD_URL ?? "https://api.alfrd.net";
  const name = input.name ?? process.env.DESKTOP_CLIENT_NAME ?? "Alfred";
  const uri = buildClaimUri({ serverId, claimSecret, cloudUrl, name });

  return {
    v: CLAIM_QR_VERSION,
    type: "alfred.desktop.claim",
    serverId,
    desktopClientId: serverId,
    claimSecret,
    cloudUrl,
    name,
    uri,
  };
}

/**
 * Parse a scanned QR string (deep link or JSON). Returns null if unrecognized.
 */
export function parseClaimQrPayload(raw: string): {
  serverId: string;
  claimSecret: string;
  cloudUrl?: string;
  name?: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as Partial<ClaimPayload>;
      if (
        json.type === "alfred.desktop.claim" &&
        typeof json.serverId === "string" &&
        typeof json.claimSecret === "string"
      ) {
        return {
          serverId: json.serverId,
          claimSecret: json.claimSecret.trim().toUpperCase(),
          cloudUrl: typeof json.cloudUrl === "string" ? json.cloudUrl : undefined,
          name: typeof json.name === "string" ? json.name : undefined,
        };
      }
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== `${CLAIM_URI_SCHEME}:` || url.hostname !== CLAIM_URI_HOST) {
      return null;
    }
    const serverId = url.searchParams.get("serverId");
    const claimSecret = url.searchParams.get("claimSecret");
    if (!serverId || !claimSecret) return null;
    return {
      serverId,
      claimSecret: claimSecret.trim().toUpperCase(),
      cloudUrl: url.searchParams.get("cloudUrl") ?? undefined,
      name: url.searchParams.get("name") ?? undefined,
    };
  } catch {
    return null;
  }
}
