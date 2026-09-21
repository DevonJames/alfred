import {
  createLiveKitToken,
  dispatchLiveKitAgent,
  isLiveVoiceStack,
  liveAgentName,
  mintLiveRoomName,
} from "@alfred/livekit";
import { getDesktopIdentity, readPersistedIdentity } from "./cloud-connect.js";
import { markRobotConversation } from "./robot-conversation.js";

export type LiveKitTokenResponse = {
  url: string;
  room: string;
  identity: string;
  token: string;
  /** Present when ALFRED_VOICE_STACK=live — room will dispatch this Agents worker. */
  agentName?: string;
  voiceStack?: "cascade" | "live";
};

const IDENTITY_PREFIXES = {
  ios: "alfred-ios",
  robot: "alfred-robot",
  web: "alfred-client",
} as const;

export type LiveKitClientKind = keyof typeof IDENTITY_PREFIXES;

/**
 * Robot stays in the shared room for the face. Only the phone should wake
 * GPT-Live — and only when the caller actually wants a voice job (Talk), not
 * an HTTP conversation poll that happens to mint a LiveKit token.
 */
export function shouldDispatchLiveAgent(
  client?: string | null,
  dispatch?: boolean | null,
): boolean {
  if (dispatch === false) return false;
  if (dispatch === true) return true;
  return liveKitIdentityPrefix(client) !== IDENTITY_PREFIXES.robot;
}

export function liveKitIdentityPrefix(client?: string | null): string {
  const key = (client ?? "").trim().toLowerCase();
  if (key === "robot" || key === "alfredbot" || key === "alfred-robot") {
    return IDENTITY_PREFIXES.robot;
  }
  if (key === "web" || key === "client" || key === "desktop") {
    return IDENTITY_PREFIXES.web;
  }
  if (key === "ios" || key === "alfred-ios" || key === "phone") {
    return IDENTITY_PREFIXES.ios;
  }
  return IDENTITY_PREFIXES.ios;
}

export function usesSharedRobotRoom(opts: {
  client?: string | null;
  join?: string | null;
}): boolean {
  const join = (opts.join ?? "").trim().toLowerCase();
  if (join === "robot" || join === "alfredbot" || join === "bot") return true;
  return liveKitIdentityPrefix(opts.client) === IDENTITY_PREFIXES.robot;
}

export function robotLiveRoomName(desktopClientId?: string | null): string {
  const clean = (desktopClientId ?? "").replace(/[^a-zA-Z0-9]/g, "");
  return `alfred-bot-${clean.slice(0, 8) || "local"}`;
}

/** Robot reuses one identity so rematch replaces the peer instead of stacking. */
export function liveKitParticipantIdentity(
  prefix: string,
  desktopClientId?: string | null,
): string {
  if (prefix === IDENTITY_PREFIXES.robot) {
    const clean = (desktopClientId ?? "").replace(/[^a-zA-Z0-9]/g, "");
    return `${prefix}-${clean.slice(0, 8) || "local"}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * GPT-Live normally mints a fresh room per Talk session. AlfredBot + the
 * iPhone-as-audio path need one stable room so the face and the phone share
 * the same agent. Cascade already uses the fixed LIVEKIT_ROOM.
 */
export function resolveLiveKitRoomName(opts: {
  live: boolean;
  client?: string | null;
  join?: string | null;
  desktopClientId?: string | null;
  fallbackRoom: string;
}): string {
  if (opts.live && usesSharedRobotRoom(opts)) {
    return robotLiveRoomName(opts.desktopClientId);
  }
  return opts.fallbackRoom;
}

async function desktopIdForRobotRoom(): Promise<string> {
  const live = getDesktopIdentity().desktopClientId;
  if (live) return live;
  const persisted = await readPersistedIdentity();
  return persisted?.desktopClientId ?? "local";
}

export async function mintLiveKitClientToken(
  opts: { client?: string | null; join?: string | null; dispatch?: boolean | null } = {},
): Promise<{ ok: true; body: LiveKitTokenResponse } | { ok: false; error: string; status: 500 }> {
  const identityPrefix = liveKitIdentityPrefix(opts.client);
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return {
      ok: false,
      status: 500,
      error: "Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in the repo .env",
    };
  }

  const live = isLiveVoiceStack();
  const desktopClientId = await desktopIdForRobotRoom();
  const room = resolveLiveKitRoomName({
    live,
    client: opts.client,
    join: opts.join,
    desktopClientId,
    fallbackRoom: mintLiveRoomName(),
  });
  const identity = liveKitParticipantIdentity(identityPrefix, desktopClientId);
  const agentName =
    live && shouldDispatchLiveAgent(opts.client, opts.dispatch) ? liveAgentName() : undefined;
  if (agentName && usesSharedRobotRoom(opts)) {
    markRobotConversation(true);
  }
  try {
    const token = await createLiveKitToken({
      apiKey,
      apiSecret,
      roomName: room,
      identity,
      agentName,
    });
    // Token roomConfig only applies on room *create*. Unique live rooms usually
    // create; API dispatch covers races / remints into a still-open name.
    if (agentName) {
      try {
        const dispatched = await dispatchLiveKitAgent({
          url,
          apiKey,
          apiSecret,
          roomName: room,
          agentName,
          metadata: JSON.stringify({ stack: "gpt-live", identity }),
        });
        console.log(
          `[livekit-token] voiceStack=live room=${room} agent=${agentName} dispatch=${dispatched.created ? "created" : dispatched.reason ?? "skipped"}`,
        );
      } catch (err) {
        console.warn("[livekit-token] agent dispatch failed (token roomConfig may still work):", err);
      }
    } else if (live) {
      console.log(`[livekit-token] voiceStack=live room=${room} agent=skipped`);
    } else {
      console.log(`[livekit-token] voiceStack=cascade room=${room}`);
    }
    return {
      ok: true,
      body: {
        url,
        room,
        identity,
        token,
        ...(live
          ? { ...(agentName ? { agentName } : {}), voiceStack: "live" as const }
          : { voiceStack: "cascade" as const }),
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function livekitConfigured(): boolean {
  return !!(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
}
