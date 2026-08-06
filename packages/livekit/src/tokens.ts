import { AccessToken } from "livekit-server-sdk";

export interface LiveKitTokenOptions {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  ttlSeconds?: number;
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
  return at.toJwt();
}
