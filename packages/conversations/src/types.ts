export type ConversationModality = "voice" | "chat" | "mixed";
export type ConversationStack = "cascade" | "live" | "live2";
export type MessageSource = "voice" | "text";

export type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modality: ConversationModality;
  stack?: ConversationStack;
  preview: string;
  messageCount: number;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  source: MessageSource;
};

export type ConversationRecord = ConversationSummary & {
  messages: ConversationMessage[];
};

export type ConversationIndexFile = {
  activeId: string | null;
  /** After New chat — next ensureActive creates a fresh conversation. */
  forceNewNext: boolean;
  conversations: ConversationSummary[];
};
