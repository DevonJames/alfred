import { RoomServiceClient } from "livekit-server-sdk";

export interface AgentPresenceOptions {
  url: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
  /** Exact identity or prefix (default alfred-agent). */
  identity?: string;
}

function httpHostFromLiveKitUrl(url: string): string {
  return url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

/**
 * True when a participant matching the voice-agent identity is in the room.
 * Used by desktop `/api/session/status` so iOS can tell empty-room joins apart
 * from a healthy Mac voice process.
 */
export async function isAgentInRoom(opts: AgentPresenceOptions): Promise<boolean> {
  const identity = opts.identity ?? "alfred-agent";
  const host = httpHostFromLiveKitUrl(opts.url);
  const client = new RoomServiceClient(host, opts.apiKey, opts.apiSecret);
  try {
    const participants = await client.listParticipants(opts.roomName);
    return participants.some(
      (p) => p.identity === identity || p.identity.startsWith(`${identity}-`),
    );
  } catch {
    return false;
  }
}
