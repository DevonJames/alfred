import { randomBytes, randomInt } from "node:crypto";

export const PIN_EXPIRY_SECONDS = 300;

export function generatePin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function generateDeviceToken(): string {
  return randomBytes(48).toString("base64url");
}

export function getPairingExpiresAt(now = new Date()): string {
  const d = new Date(now.getTime() + PIN_EXPIRY_SECONDS * 1000);
  return d.toISOString();
}

export function expiresInSeconds(): number {
  return PIN_EXPIRY_SECONDS;
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const trimmed = authorization.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice(7).trim() || null;
  }
  return trimmed || null;
}
