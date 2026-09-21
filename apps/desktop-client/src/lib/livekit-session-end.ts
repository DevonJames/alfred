import { deleteLiveKitRoom, isEphemeralLiveRoom } from "@alfred/livekit";
import { getDesktopIdentity, readPersistedIdentity } from "./cloud-connect.js";
import { robotLiveRoomName } from "./livekit-token.js";
import { markRobotConversation } from "./robot-conversation.js";

async function desktopIdForRobotRoom(): Promise<string> {
  const live = getDesktopIdentity().desktopClientId;
  if (live) return live;
  const persisted = await readPersistedIdentity();
  return persisted?.desktopClientId ?? "local";
}

/**
 * Hangup: drop the conversation flag and delete the LiveKit room so leftover
 * phones, robots, and GPT-Live jobs cannot keep billing a session.
 */
export async function endLiveConversation(sessionId?: string): Promise<void> {
  markRobotConversation(false);

  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return;

  const rooms = new Set<string>();
  rooms.add(robotLiveRoomName(await desktopIdForRobotRoom()));
  if (sessionId && isEphemeralLiveRoom(sessionId)) rooms.add(sessionId);

  for (const roomName of rooms) {
    await deleteLiveKitRoom({ url, apiKey, apiSecret, roomName });
  }
}
