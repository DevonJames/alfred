import {
  createConversationStore,
  type ConversationStack,
  type MessageSource,
} from "@alfred/conversations";

let stackHint: ConversationStack = "cascade";

export function setConversationHistoryStack(stack: ConversationStack): void {
  stackHint = stack;
}

export function conversationHistoryPort() {
  const store = createConversationStore();
  return {
    async append(opts: {
      role: "user" | "assistant";
      text: string;
      source: MessageSource;
    }): Promise<void> {
      await store.appendMessage({
        role: opts.role,
        text: opts.text,
        source: opts.source,
        stack: stackHint,
      });
    },
  };
}

export async function appendConversationTurn(opts: {
  role: "user" | "assistant";
  text: string;
  source: MessageSource;
  stack?: ConversationStack;
}): Promise<void> {
  await createConversationStore().appendMessage({
    role: opts.role,
    text: opts.text,
    source: opts.source,
    stack: opts.stack ?? stackHint,
  });
}
