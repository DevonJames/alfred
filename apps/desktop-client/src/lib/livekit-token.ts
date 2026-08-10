import { createLiveKitToken } from "@alfred/livekit";

export type LiveKitTokenResponse = {
  url: string;
  room: string;
  identity: string;
  token: string;
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

  const room = process.env.LIVEKIT_ROOM ?? "alfred-dev";
  const identity = `${identityPrefix}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const token = await createLiveKitToken({
      apiKey,
      apiSecret,
      roomName: room,
      identity,
    });
    return { ok: true, body: { url, room, identity, token } };
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
