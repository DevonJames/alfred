import { AccessToken, AgentDispatchClient, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { isAgentInRoom, roomHasPhoneParticipant } from "./agent-presence.js";

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
    canPublishData: true,
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
 * Skip only when a live conversation is already up (agent + phone).
 * A leftover agent after hangup must be replaced — skipping leaves Talk
 * waiting forever.
 */
export function nextAgentDispatchAction(opts: {
  hasDispatch: boolean;
  agentInRoom: boolean;
  phoneInRoom?: boolean;
}): "skip" | "create" | "replace" {
  if (opts.agentInRoom && opts.phoneInRoom) return "skip";
  if (opts.agentInRoom || opts.hasDispatch) return "replace";
  return "create";
}

/**
 * Explicit Agents dispatch for an existing or new room.
 * Token roomConfig only fires when the room is *created*; this covers remints
 * into a still-open room. Stale dispatches (job gone, room still up) are
 * replaced so AlfredBot + iPhone audio can wake him again.
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
  let stale: { id: string }[] = [];
  try {
    const existing = await client.listDispatch(opts.roomName);
    const forAgent = existing.filter((d) => d.agentName === opts.agentName);
    const presence = {
      url: opts.url,
      apiKey: opts.apiKey,
      apiSecret: opts.apiSecret,
      roomName: opts.roomName,
    };
    const [present, phoneInRoom] = await Promise.all([
      isAgentInRoom(presence),
      roomHasPhoneParticipant(presence),
    ]);
    const action = nextAgentDispatchAction({
      hasDispatch: forAgent.length > 0,
      agentInRoom: present,
      phoneInRoom,
    });
    if (action === "skip") {
      return { created: false, reason: "already_dispatched" };
    }
    if (action === "replace") {
      stale = forAgent.filter((d) => d.id).map((d) => ({ id: d.id }));
    }
  } catch {
    // list can fail on a brand-new room name — fall through to create
  }

  for (const dispatch of stale) {
    try {
      await client.deleteDispatch(dispatch.id, opts.roomName);
    } catch {
      // create may still succeed
    }
  }

  try {
    await client.createDispatch(opts.roomName, opts.agentName, {
      metadata: opts.metadata,
    });
    return { created: true, reason: stale.length ? "replaced_stale" : undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Race: another mint created the same dispatch between list and create.
    if (/already|exist/i.test(message)) {
      const present = await isAgentInRoom({
        url: opts.url,
        apiKey: opts.apiKey,
        apiSecret: opts.apiSecret,
        roomName: opts.roomName,
      });
      const phoneInRoom = await roomHasPhoneParticipant({
        url: opts.url,
        apiKey: opts.apiKey,
        apiSecret: opts.apiSecret,
        roomName: opts.roomName,
      });
      if (present && phoneInRoom) return { created: false, reason: "already_dispatched" };
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
