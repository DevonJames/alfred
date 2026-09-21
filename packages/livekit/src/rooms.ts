import { RoomServiceClient } from "livekit-server-sdk";

function httpHostFromLiveKitUrl(url: string): string {
  return url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

/**
 * Talk and AlfredBot rooms are disposable. Cascade's long-lived
 * `alfred-dev` (and any other fixed room) must not be deleted from hangup.
 */
export function isEphemeralLiveRoom(roomName: string): boolean {
  const name = roomName.trim();
  if (!name || name === "alfred-dev") return false;
  return name.startsWith("alfred-bot-") || name.includes("-live-");
}

export async function deleteLiveKitRoom(opts: {
  url: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
}): Promise<{ deleted: boolean; reason?: string; participants?: string[] }> {
  const roomName = opts.roomName.trim();
  if (!roomName) return { deleted: false, reason: "empty" };
  if (!isEphemeralLiveRoom(roomName)) return { deleted: false, reason: "protected" };

  const client = new RoomServiceClient(httpHostFromLiveKitUrl(opts.url), opts.apiKey, opts.apiSecret);
  let participants: string[] = [];
  try {
    const listed = await client.listParticipants(roomName);
    participants = listed.map((p) => p.identity).filter((id): id is string => Boolean(id));
  } catch {
    // Room may already be gone — still try delete.
  }

  console.log(
    `[livekit] deleting room ${roomName} (${participants.length} participants: ${participants.join(", ") || "none"})`,
  );

  try {
    await client.deleteRoom(roomName);
    return { deleted: true, participants };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|does not exist|404/i.test(message)) {
      return { deleted: false, reason: "gone", participants };
    }
    console.warn(`[livekit] deleteRoom ${roomName} failed:`, message);
    return { deleted: false, reason: message, participants };
  }
}
