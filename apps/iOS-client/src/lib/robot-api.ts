import type { BotClaimPayload } from "./bot-qr";
import type { ConnectionMode } from "./types";

export class RobotApiError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message);
    this.name = "RobotApiError";
  }
}

export function botConnectionType(mode: ConnectionMode): "lan" | "wan" | "relay" | "offline" {
  if (mode === "local") return "lan";
  if (mode === "direct") return "wan";
  if (mode === "relay") return "relay";
  return "offline";
}

async function robotFetch<T>(
  host: string,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 5000, ...req } = init;
  const headers = new Headers(req.headers);
  if (req.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const url = `${host.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...req, headers, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RobotApiError("AlfredBot didn't answer in time.", 0);
    }
    throw new RobotApiError("Couldn't reach AlfredBot on this network.", 0);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = { error: raw };
  }
  if (!res.ok) {
    const body = parsed as { error?: string } | null;
    throw new RobotApiError(body?.error ?? `AlfredBot request failed (${res.status})`, res.status);
  }
  return parsed as T;
}

export async function reachBot(payload: BotClaimPayload): Promise<string> {
  for (const host of payload.hosts) {
    try {
      const identity = await robotFetch<{ botId?: string }>(host, "/api/identity");
      if (identity.botId === payload.botId) return host;
    } catch {
      // try the next advertised address
    }
  }
  throw new RobotApiError("This phone can't see AlfredBot. Stay on the same Wi-Fi as the robot.");
}

export function provisionRobot(
  host: string,
  body: {
    session: string;
    cloudToken: string;
    cloudServerId: string;
    serverUrl: string;
    connectionType: "lan" | "wan" | "relay" | "offline";
    desktopName?: string | null;
  }
) {
  return robotFetch<{ ok: boolean; screen: string; desktopName?: string | null }>(host, "/api/provision", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function provisionRobotPair(
  host: string,
  body: { session: string; deviceToken: string; deviceId: string; desktopName?: string | null }
) {
  return robotFetch<{ ok: boolean; screen: string }>(host, "/api/provision-pair", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type HeadStatus = {
  mocked?: boolean;
  tracking?: boolean;
  trackerLive?: boolean;
  pcaPresent?: boolean;
  acks?: string[];
  via?: string;
  error?: string;
};

export function fetchHeadStatus(host: string) {
  return robotFetch<HeadStatus>(host, "/api/head/status");
}

export function moveHeadStick(
  host: string,
  body: { neck: number; tilt: number; roll: number; dtMs: number }
) {
  return robotFetch<{ ok: boolean }>(host, "/api/head/stick", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function releaseHead(host: string) {
  return robotFetch<{ ok: boolean }>(host, "/api/head/release", { method: "POST" });
}

export function invertHeadStick(
  stick: { neck: number; tilt: number; roll: number },
  invertLR: boolean
) {
  if (!invertLR) return stick;
  return { neck: -stick.neck, tilt: stick.tilt, roll: -stick.roll };
}

export function invertWheelStick(stick: { left: number; right: number }, facingMe: boolean) {
  if (!facingMe) return stick;
  return { left: -stick.right, right: -stick.left };
}

export function moveWheelStick(host: string, body: { left: number; right: number }) {
  return robotFetch<{ ok: boolean }>(host, "/api/wheels/stick", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function releaseWheels(host: string) {
  return robotFetch<{ ok: boolean }>(host, "/api/wheels/release", { method: "POST" });
}

export function waveArm(host: string) {
  return robotFetch<{ ok: boolean }>(host, "/api/arm/wave", { method: "POST", timeoutMs: 30_000 });
}

export function setHeadTracking(host: string, enabled: boolean) {
  return robotFetch<{ ok: boolean; tracking: boolean }>(host, "/api/head/tracking", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export type CameraStatus = {
  running?: boolean;
  preview?: boolean;
  hasFrame?: boolean;
  error?: string | null;
  rotation?: number;
};

export function setRobotCameraPreview(host: string, enabled: boolean) {
  return robotFetch<CameraStatus>(host, "/api/camera/preview", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function setRobotTalkListen(host: string, listen: boolean) {
  return robotFetch<{ ok: boolean; conversation: boolean }>(
    host,
    listen ? "/api/talk/listen" : "/api/talk/hangup",
    { method: "POST" }
  );
}

export function setRobotAudioSource(host: string, source: "phone" | "local") {
  return robotFetch<{ ok: boolean; audioSource: "phone" | "local" }>(host, "/api/audio/source", {
    method: "POST",
    body: JSON.stringify({ source }),
  });
}

export function fetchCameraStatus(host: string) {
  return robotFetch<CameraStatus>(host, "/api/camera/status");
}

export function cameraLatestUri(host: string, tick: number) {
  return `${host.replace(/\/$/, "")}/api/camera/latest.jpg?t=${tick}`;
}
