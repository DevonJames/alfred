import {
  createLiveKitToken,
  dispatchLiveKitAgent,
  isLiveVoiceStack,
  liveAgentName,
  mintLiveRoomName,
} from "@alfred/livekit";

export type LiveKitTokenResponse = {
  url: string;
  room: string;
  identity: string;
  token: string;
  /** Present when ALFRED_VOICE_STACK=live — room will dispatch this Agents worker. */
  agentName?: string;
  voiceStack?: "cascade" | "live";
};

export async function mintLiveKitClientToken(
  identityPrefix = "alfred-client",
): Promise<{ ok: true; body: LiveKitTokenResponse } | { ok: false; error: string; status: 500 }> {
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
  const room = mintLiveRoomName();
  const identity = `${identityPrefix}-${Math.random().toString(36).slice(2, 8)}`;
  const agentName = live ? liveAgentName() : undefined;
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
        ...(agentName
          ? { agentName, voiceStack: "live" as const }
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
