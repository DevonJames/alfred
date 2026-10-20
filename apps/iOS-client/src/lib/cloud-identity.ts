/**
 * Link-session restore for accountless alfrd.net access.
 *
 * The phone proves the Mac's claim secret once (`linkDesktop`), then keeps a
 * scoped JWT in the Keychain. There is no email/password account.
 */
import { ApiError, getCandidates, linkDesktop } from "./cloud-api";
import { useConnection } from "./connection";
import { KEYS, getItem, removeItem, setItem } from "./secure-store";

/** Re-mint while the current token still has this much life left. */
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

export function linkTokenExpiryMs(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(globalThis.atob(padded)) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function linkTokenNeedsRenewal(token: string | null, withinMs = RENEW_WITHIN_MS): boolean {
  if (!token) return true;
  const exp = linkTokenExpiryMs(token);
  if (exp == null) return false;
  return exp - Date.now() <= withinMs;
}

/**
 * Exchange the stored Desktop Client ID + claim secret for a fresh link JWT.
 * Returns null when the secret was never saved or the Mac rejected it.
 */
export async function renewStoredLink(): Promise<string | null> {
  const [serverId, claimSecret] = await Promise.all([
    getItem(KEYS.cloudServerId),
    getItem(KEYS.claimSecret),
  ]);
  if (!serverId || !claimSecret) return null;
  try {
    const linked = await linkDesktop(serverId, claimSecret);
    await setItem(KEYS.cloudToken, linked.token);
    await setItem(KEYS.claimSecret, claimSecret.trim().toUpperCase());
    await useConnection.getState().setCloudSession(linked.token);
    return linked.token;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 404)) return null;
    throw err;
  }
}

/**
 * Return a usable link JWT, or null if this phone must re-enter the claim secret.
 * A stored claim secret renews an expired token without sending the user through
 * site-data clearing. Does not create accounts.
 */
export async function restoreCloudSession(): Promise<string | null> {
  const [token, serverId, claimSecret] = await Promise.all([
    getItem(KEYS.cloudToken),
    getItem(KEYS.cloudServerId),
    getItem(KEYS.claimSecret),
  ]);
  if (!serverId) return null;

  if (linkTokenNeedsRenewal(token) && claimSecret) {
    try {
      const renewed = await renewStoredLink();
      if (renewed) return renewed;
    } catch (err) {
      // Offline: keep a token that has not actually expired yet.
      if (!(err instanceof ApiError) || err.status === 0) {
        if (token && !linkTokenNeedsRenewal(token, 0)) return token;
      }
    }
  }

  if (!token) return null;
  if (linkTokenNeedsRenewal(token, 0)) {
    await removeItem(KEYS.cloudToken);
    useConnection.setState({ cloudToken: null });
    return null;
  }

  try {
    await getCandidates(token, serverId);
    await useConnection.getState().setCloudSession(token);
    return token;
  } catch (err) {
    // Network blip — keep the token so offline reopen still works.
    if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) {
      return token;
    }
    if (claimSecret) {
      try {
        const renewed = await renewStoredLink();
        if (renewed) return renewed;
      } catch {
        return token;
      }
    }
    await removeItem(KEYS.cloudToken);
    useConnection.setState({ cloudToken: null });
    return null;
  }
}

/** @deprecated no-op alias — linking no longer auto-registers an account. */
export async function ensureCloudSession(): Promise<string> {
  const existing = await restoreCloudSession();
  if (existing) return existing;
  throw new ApiError(
    "not_linked",
    "This phone is not linked to a Mac yet. Scan the claim code on your Mac.",
    401
  );
}
