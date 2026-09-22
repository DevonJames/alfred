/**
 * Bridge ElevenLabs' inbound Speech Engine socket (landed on api.alfrd.net)
 * to the local /ws handler over the existing outbound relay tunnel.
 * Audio stays on ElevenLabs; only transcript and reply frames cross here.
 */
import WebSocket, { type RawData } from "ws";

interface SpeechRelayMessage {
  type: string;
  streamId?: string;
  path?: string;
  headers?: Record<string, string>;
  data?: string;
  binary?: boolean;
  code?: number;
  reason?: string;
}

interface RelayTunnel {
  readonly readyState: number;
  send(data: string): void;
}

const localSockets = new Map<string, WebSocket>();

function relaySend(tunnel: RelayTunnel, payload: unknown): void {
  if (tunnel.readyState !== WebSocket.OPEN) return;
  tunnel.send(JSON.stringify(payload));
}

function closeLocal(streamId: string, code = 1000, reason = "closed"): void {
  const socket = localSockets.get(streamId);
  if (!socket) return;
  localSockets.delete(streamId);
  try {
    socket.close(code, reason);
  } catch {
    /* already closed */
  }
}

export function closeAllSpeechRelays(): void {
  for (const streamId of [...localSockets.keys()]) closeLocal(streamId, 1001, "tunnel_closed");
}

function forwardLocalFrame(tunnel: RelayTunnel, streamId: string, data: RawData, binary: boolean): void {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  relaySend(tunnel, {
    type: "ws-frame",
    streamId,
    binary,
    data: buf.toString("base64"),
  });
}

function openLocal(tunnel: RelayTunnel, msg: SpeechRelayMessage, port: number): void {
  const streamId = msg.streamId;
  if (!streamId) return;
  if (msg.path !== "/ws") {
    relaySend(tunnel, { type: "ws-close", streamId, code: 1008, reason: "path_not_allowed" });
    return;
  }
  closeLocal(streamId);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(msg.headers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "upgrade") continue;
    headers[key] = value;
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  localSockets.set(streamId, socket);

  socket.on("open", () => {
    console.log(`[speech-relay] ${streamId} attached to local /ws`);
    relaySend(tunnel, { type: "ws-ready", streamId });
  });
  socket.on("message", (data, isBinary) => {
    forwardLocalFrame(tunnel, streamId, data, isBinary);
  });
  socket.on("close", (code, reason) => {
    if (localSockets.get(streamId) !== socket) return;
    localSockets.delete(streamId);
    relaySend(tunnel, {
      type: "ws-close",
      streamId,
      code,
      reason: reason.toString() || "local_closed",
    });
  });
  socket.on("error", (err) => {
    console.warn(`[speech-relay] local /ws failed for ${streamId}:`, err.message);
    if (localSockets.get(streamId) === socket) localSockets.delete(streamId);
    relaySend(tunnel, { type: "ws-close", streamId, code: 1011, reason: "local_ws_failed" });
  });
}

export function handleSpeechRelayMessage(tunnel: RelayTunnel, msg: SpeechRelayMessage, port: number): boolean {
  if (!msg.streamId) return false;
  if (msg.type === "ws-open") {
    openLocal(tunnel, msg, port);
    return true;
  }
  if (msg.type === "ws-frame" && msg.data) {
    const socket = localSockets.get(msg.streamId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return true;
    const buf = Buffer.from(msg.data, "base64");
    socket.send(msg.binary ? buf : buf.toString("utf8"));
    return true;
  }
  if (msg.type === "ws-close") {
    closeLocal(msg.streamId, msg.code ?? 1000, msg.reason ?? "hub_closed");
    return true;
  }
  return false;
}
