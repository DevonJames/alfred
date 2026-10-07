import {
  createConversationStore,
  type MessageSource,
} from "@alfred/conversations";

/** Persist a Talk turn for the history drawer (live2 / Speech Engine). */
export async function appendLive2ConversationTurn(opts: {
  role: "user" | "assistant";
  text: string;
  source: MessageSource;
}): Promise<void> {
  const text = opts.text.trim();
  if (!text) return;
  await createConversationStore().appendMessage({
    role: opts.role,
    text,
    source: opts.source,
    stack: "live2",
  });
}
