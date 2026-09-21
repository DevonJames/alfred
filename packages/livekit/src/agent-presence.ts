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
async function listIdentities(opts: AgentPresenceOptions): Promise<string[]> {
  const host = httpHostFromLiveKitUrl(opts.url);
  const client = new RoomServiceClient(host, opts.apiKey, opts.apiSecret);
  try {
    const participants = await client.listParticipants(opts.roomName);
    return participants.map((p) => p.identity).filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

export async function isAgentInRoom(opts: AgentPresenceOptions): Promise<boolean> {
  const identity = opts.identity ?? "alfred-agent";
  const identities = await listIdentities(opts);
  return identities.some((id) => id === identity || id.startsWith(`${identity}-`));
}

/** True when an iPhone Talk peer is already in the room. */
export async function roomHasPhoneParticipant(opts: AgentPresenceOptions): Promise<boolean> {
  const identities = await listIdentities(opts);
  return identities.some((id) => id.startsWith("alfred-ios"));
}
