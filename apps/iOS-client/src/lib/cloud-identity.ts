/**
 * The phone's own alfrd.net identity.
 *
 * Pairing is meant to feel like one act: scan the code on the Mac, done. But
 * `POST /servers/claim` is authenticated — the control plane will only bind a
 * desktop to an *account*. Rather than making the user invent an email and a
 * password to satisfy that, the app registers a random account for this device
 * and keeps the credentials in the Keychain. The user never sees it.
 *
 * Consequences worth knowing:
 *  - The account is per-install. Reinstalling loses it if the Keychain entry is
 *    gone with it, and the Mac then answers a fresh claim with `409` — the
 *    claim screen offers the alfrd.net sign-in as the way out of that.
 *  - A second phone is a second account, so it must claim the Mac in its own
 *    right, or sign in to the first phone's account.
 */
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { ApiError, login, me, register } from "./cloud-api";
import { useConnection } from "./connection";
import { KEYS, getItem, setItem } from "./secure-store";

/** Bound by nothing but readability in logs; the domain is never mailed to. */
const DEVICE_EMAIL_DOMAIN = "device.alfrd.net";

export type AccountKind = "device" | "user";

function randomHex(bytes: number): string {
  return [...Crypto.getRandomBytes(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function deviceName(): string {
  return Device.deviceName?.trim() || "iPhone";
}

async function generateCredentials(): Promise<{ email: string; password: string }> {
  return {
    email: `alfred-${randomHex(8)}@${DEVICE_EMAIL_DOMAIN}`,
    // Long enough that it is not worth attacking, and nobody ever types it.
    password: `${randomHex(16)}Aa1!`,
  };
}

async function remember(token: string, email: string, kind: AccountKind): Promise<string> {
  await setItem(KEYS.cloudAccountKind, kind);
  await useConnection.getState().setCloudSession(token, email);
  return token;
}

/**
 * Reuse a session we already have, without creating anything. Returns null when
 * this phone has no usable identity yet — the caller decides whether that is
 * worth provisioning for.
 */
export async function restoreCloudSession(): Promise<string | null> {
  const [token, email, password, kind] = await Promise.all([
    getItem(KEYS.cloudToken),
    getItem(KEYS.cloudEmail),
    getItem(KEYS.cloudPassword),
    getItem(KEYS.cloudAccountKind),
  ]);

  if (token) {
    try {
      const result = await me(token);
      return await remember(token, result?.user?.email ?? email ?? "", (kind as AccountKind) ?? "device");
    } catch (err) {
      // A network failure is not an invalid token: keep the session and let the
      // caller work offline rather than logging the phone out of a live account.
      if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) return token;
    }
  }

  // The token expired. A device account can sign itself back in silently; a
  // human account cannot, and must be asked.
  if (email && password) {
    try {
      const result = await login(email, password);
      return await remember(result.token, result.user.email, "device");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Guarantee a cloud token, registering this phone's account on first use.
 * Called at the moment of claiming — never on a screen the user is only
 * looking at — so an idle install leaves nothing behind on the control plane.
 */
export async function ensureCloudSession(): Promise<string> {
  const existing = await restoreCloudSession();
  if (existing) return existing;

  const stored = {
    email: await getItem(KEYS.cloudEmail),
    password: await getItem(KEYS.cloudPassword),
  };
  const credentials =
    stored.email && stored.password
      ? { email: stored.email, password: stored.password }
      : await generateCredentials();

  try {
    const result = await register(credentials.email, credentials.password, deviceName());
    await Promise.all([
      setItem(KEYS.cloudEmail, credentials.email),
      setItem(KEYS.cloudPassword, credentials.password),
    ]);
    return await remember(result.token, result.user.email, "device");
  } catch (err) {
    // Registering an address that already exists means these credentials were
    // stored on a previous run whose token we've since lost. Sign in instead.
    if (err instanceof ApiError && (err.status === 409 || err.status === 400)) {
      const result = await login(credentials.email, credentials.password);
      await Promise.all([
        setItem(KEYS.cloudEmail, credentials.email),
        setItem(KEYS.cloudPassword, credentials.password),
      ]);
      return await remember(result.token, result.user.email, "device");
    }
    throw err;
  }
}

/** True when the session belongs to a real alfrd.net sign-in, not this phone. */
export async function accountKind(): Promise<AccountKind> {
  return ((await getItem(KEYS.cloudAccountKind)) as AccountKind) ?? "device";
}

/** Used by the optional sign-in screen so later refreshes don't overwrite it. */
export async function markUserAccount(token: string, email: string): Promise<void> {
  await remember(token, email, "user");
}
