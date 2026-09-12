import { AccessToken, AgentDispatchClient, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";

export interface LiveKitTokenOptions {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  ttlSeconds?: number;
  /**
   * When set (GPT-Live / Agents worker), embed RoomAgentDispatch so joining
   * the room explicitly dispatches that agentName.
   */
  agentName?: string;
}

function httpHostFromLiveKitUrl(url: string): string {
  return url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

/** Mint a participant token for the voice agent or a test client. */
export async function createLiveKitToken(opts: LiveKitTokenOptions): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, {
    identity: opts.identity,
    ttl: opts.ttlSeconds ?? 60 * 60,
  });
  at.addGrant({
    roomJoin: true,
    room: opts.roomName,
    canPublish: true,
    canSubscribe: true,
  });
  const agentName = opts.agentName?.trim();
  if (agentName) {
    at.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName,
        }),
      ],
    });
  }
  return at.toJwt();
}

/**
 * Explicit Agents dispatch for an existing or new room.
 * Token roomConfig only fires when the room is *created*; this covers remints
 * into a still-open room and is idempotent enough for Alfred's Talk flow when
 * paired with unique per-session rooms.
 */
export async function dispatchLiveKitAgent(opts: {
  url: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
  agentName: string;
  metadata?: string;
}): Promise<{ created: boolean; reason?: string }> {
  const host = httpHostFromLiveKitUrl(opts.url);
  const client = new AgentDispatchClient(host, opts.apiKey, opts.apiSecret);
  try {
    const existing = await client.listDispatch(opts.roomName);
    if (existing.some((d) => d.agentName === opts.agentName)) {
      return { created: false, reason: "already_dispatched" };
    }
  } catch {
    // list can fail on a brand-new room name — fall through to create
  }
  try {
    await client.createDispatch(opts.roomName, opts.agentName, {
      metadata: opts.metadata,
    });
    return { created: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Race: another mint created the same dispatch between list and create.
    if (/already|exist/i.test(message)) {
      return { created: false, reason: "already_dispatched" };
    }
    throw err;
  }
}

/** True when desktop/voice should mint tokens that dispatch the GPT-Live agent. */
export function isLiveVoiceStack(): boolean {
  const stack = (process.env.ALFRED_VOICE_STACK ?? "").trim().toLowerCase();
  return stack === "live" || stack === "gpt-live" || stack === "gptlive";
}

export function liveAgentName(): string {
  return process.env.LIVEKIT_AGENT_NAME?.trim() || "alfred-live";
}

/**
 * Cascade keeps a long-lived fixed room (agent always waiting).
 * GPT-Live must use a fresh room per Talk session so token RoomAgentDispatch
 * fires (LiveKit only applies token agents on room *create*), and so the job
 * ends cleanly when the client leaves.
 */
export function mintLiveRoomName(): string {
  const base = (process.env.LIVEKIT_ROOM ?? "alfred-dev").replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!isLiveVoiceStack()) return base || "alfred-dev";
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${base || "alfred"}-live-${suffix}`;
}
