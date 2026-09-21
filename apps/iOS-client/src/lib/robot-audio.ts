import { setRobotAudioSource } from "./robot-api";
import { getItem, setItem, KEYS } from "./secure-store";

/** Phone is the mic/speaker. False + a claimed bot means AlfredBot has the voice. */
export async function isRobotAudioEnabled(): Promise<boolean> {
  const raw = await getItem(KEYS.robotAudio);
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return false;
}

export async function setRobotAudioEnabled(enabled: boolean): Promise<void> {
  await setItem(KEYS.robotAudio, enabled ? "1" : "0");
}

export type TalkAudioRoute = "phone" | "robot";

export async function setTalkAudioRoute(route: TalkAudioRoute): Promise<void> {
  const host = await getRobotHost();
  if (route === "robot" && !host) {
    throw new Error("Claim AlfredBot first, then you can put his voice on the robot.");
  }
  if (host) {
    await setRobotAudioSource(host, route === "robot" ? "local" : "phone");
  }
  await setRobotAudioEnabled(route === "phone");
}

export async function setRobotHost(host: string): Promise<void> {
  await setItem(KEYS.robotHost, host);
}

export async function getRobotHost(): Promise<string | null> {
  return getItem(KEYS.robotHost);
}

export async function isRobotClaimed(): Promise<boolean> {
  return Boolean(await getRobotHost());
}

/**
 * Talk uses the shared AlfredBot room only when the bot is claimed *and* this
 * switch is on. Off means a normal phone session — no robot required.
 */
export async function isRobotTalkEnabled(): Promise<boolean> {
  if (!(await isRobotClaimed())) return false;
  const raw = await getItem(KEYS.robotTalk);
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return true;
}

export async function setRobotTalkEnabled(enabled: boolean): Promise<void> {
  await setItem(KEYS.robotTalk, enabled ? "1" : "0");
}
