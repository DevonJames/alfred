/** Remote LiveKit identities the cascade agent can see. */
let identities: string[] = [];

export function noteRoomIdentities(next: string[]): void {
  identities = next;
}

/**
 * True when FitnessAlly is in the room. The on-screen recipe or workout is then
 * part of every spoken turn, including when the Alfred iPhone is also connected.
 */
export function fitnessAllyOwnsVoice(): boolean {
  return identities.some((id) => id.startsWith("alfred-fitness"));
}
