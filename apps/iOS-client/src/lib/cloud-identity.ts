/**
 * Link-session restore for accountless alfrd.net access.
 *
 * The phone proves the Mac's claim secret once (`linkDesktop`), then keeps a
 * scoped JWT in the Keychain. There is no email/password account.
 */
import { ApiError, getCandidates } from "./cloud-api";
import { useConnection } from "./connection";
import { KEYS, getItem, removeItem } from "./secure-store";

/**
 * Return a usable link JWT, or null if this phone must re-link the Mac.
 * Does not create accounts.
 */
export async function restoreCloudSession(): Promise<string | null> {
  const [token, serverId] = await Promise.all([
    getItem(KEYS.cloudToken),
    getItem(KEYS.cloudServerId),
  ]);
  if (!token || !serverId) return null;

  try {
    await getCandidates(token, serverId);
    await useConnection.getState().setCloudSession(token);
    return token;
  } catch (err) {
    // Network blip — keep the token so offline reopen still works.
    if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) {
      return token;
    }
    await removeItem(KEYS.cloudToken);
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
