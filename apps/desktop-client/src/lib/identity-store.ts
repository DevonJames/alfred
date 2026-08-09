/**
 * Filesystem identity store for the desktop client's alfrd.net registration.
 * Replaces alfred-home's householdSettings DB columns.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface DesktopClientIdentity {
  desktopClientId: string;
  claimSecret: string;
  cloudDesktopToken: string | null;
  displayName: string;
}

function identityPath(): string {
  const override = process.env.ALFRED_DESKTOP_IDENTITY_PATH;
  if (override) return resolve(override);
  // apps/desktop-client → repo root data/
  return resolve(process.cwd(), "../../data/desktop-client/identity.json");
}

export async function loadIdentity(): Promise<DesktopClientIdentity | null> {
  try {
    const raw = await readFile(identityPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DesktopClientIdentity>;
    if (!parsed.desktopClientId || !parsed.claimSecret) return null;
    return {
      desktopClientId: parsed.desktopClientId,
      claimSecret: parsed.claimSecret,
      cloudDesktopToken: parsed.cloudDesktopToken ?? null,
      displayName: parsed.displayName ?? process.env.DESKTOP_CLIENT_NAME ?? "Alfred",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function saveIdentity(identity: DesktopClientIdentity): Promise<void> {
  const path = identityPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

export async function updateIdentity(
  patch: Partial<DesktopClientIdentity>,
): Promise<DesktopClientIdentity> {
  const current = await loadIdentity();
  if (!current) {
    throw new Error("[IdentityStore] No identity to update — create first");
  }
  const next: DesktopClientIdentity = { ...current, ...patch };
  await saveIdentity(next);
  return next;
}
