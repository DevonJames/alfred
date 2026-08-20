export function isSidecarMode(): boolean {
  return process.env.ALFRED_SIDECAR_MODE === "true";
}

export function sidecarPort(fallback = 3000): number {
  if (process.env.PORT) return Number(process.env.PORT);
  return isSidecarMode() ? 3100 : fallback;
}

export function sidecarHostname(): string {
  if (process.env.HOST) return process.env.HOST;
  return isSidecarMode() ? "127.0.0.1" : "0.0.0.0";
}

export function coreSecret(): string {
  return process.env.ALFRED_CORE_SECRET?.trim() ?? "";
}
