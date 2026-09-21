/**
 * AlfredBot only joins LiveKit while a phone Talk is up. Token mint for
 * join=robot (iOS) turns this on; POST /api/session/end turns it off.
 *
 * `id` increments on every start so the face can tell a rematch from a
 * leftover join and reconnect to the new agent.
 */
let active = false;
let conversationId = 0;

export function markRobotConversation(on: boolean): void {
  if (on) {
    conversationId += 1;
    active = true;
    return;
  }
  active = false;
}

export function isRobotConversation(): boolean {
  return active;
}

export function robotConversationId(): number {
  return conversationId;
}
