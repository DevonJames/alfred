import type { CaptionMessage } from "./captions.js";
import { markdownToHtml } from "./markdown.js";

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
};

/** True when `next` is the same reply growing, or an earlier prefix of it. */
function extendsUtterance(prev: string, next: string): boolean {
  const a = prev.trim();
  const b = next.trim();
  if (!a || !b) return false;
  return b.startsWith(a) || a.startsWith(b);
}

/** In-memory conversation thread rendered into a single DOM root. */
export class TranscriptThread {
  private messages: ThreadMessage[] = [];
  private seq = 0;
  private assistantId?: string;

  constructor(private readonly root: HTMLElement) {
    this.render();
  }

  /** Replace the thread with a stored conversation (history resume). */
  load(messages: Array<{ id?: string; role: "user" | "assistant"; text: string }>): void {
    this.messages = messages
      .map((m, i) => ({
        id: m.id?.trim() || `hist_${i + 1}`,
        role: m.role,
        text: m.text.trim(),
        streaming: false,
      }))
      .filter((m) => m.text);
    this.seq = this.messages.length;
    this.assistantId = undefined;
    this.render();
  }

  addLocalUser(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user" && last.text === trimmed) return;
    this.messages.push({ id: `local_${++this.seq}`, role: "user", text: trimmed });
    this.assistantId = undefined;
    this.render();
  }

  handleUserFinal(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = this.currentAssistant();
    if (current) current.streaming = false;
    this.assistantId = undefined;
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user" && last.text === trimmed) return;
    this.messages.push({ id: `user_${++this.seq}`, role: "user", text: trimmed });
    this.assistantId = undefined;
    this.render();
  }

  handleCaption(msg: CaptionMessage): void {
    if (msg.type === "start" || msg.type === "reveal") {
      this.upsertAssistant(msg.text, true);
      return;
    }
    const current = this.currentAssistant();
    if (current) current.streaming = false;
    this.assistantId = undefined;
    this.render();
  }

  /** End an in-flight assistant bubble without wiping history (Stop uplink). */
  endStreaming(): void {
    for (const m of this.messages) m.streaming = false;
    this.assistantId = undefined;
    this.render();
  }

  reset(): void {
    this.messages = [];
    this.assistantId = undefined;
    this.render();
  }

  /**
   * One bubble per spoken reply. GPT-Live republishes the same utterance as it
   * grows ("I'm on" then "I'm on it"); those extend the last assistant line.
   */
  private upsertAssistant(text: string, streaming: boolean): void {
    const tail = this.messages[this.messages.length - 1];
    if (tail?.role === "assistant" && extendsUtterance(tail.text, text)) {
      if (text.trim().length >= tail.text.trim().length) tail.text = text;
      tail.streaming = streaming;
      this.assistantId = tail.id;
      this.render();
      return;
    }
    if (!text.trim() && tail?.role === "assistant" && tail.streaming) {
      this.assistantId = tail.id;
      return;
    }
    this.assistantId = `asst_${++this.seq}`;
    this.messages.push({
      id: this.assistantId,
      role: "assistant",
      text,
      streaming,
    });
    this.render();
  }

  private currentAssistant(): ThreadMessage | undefined {
    if (!this.assistantId) return undefined;
    return this.messages.find((m) => m.id === this.assistantId);
  }

  private render(): void {
    this.root.replaceChildren();
    for (const m of this.messages) {
      if (!m.text && m.streaming) continue;
      const el = document.createElement("p");
      el.className = `bubble bubble-${m.role}${m.streaming ? " streaming" : ""}`;
      if (m.role === "assistant") {
        el.innerHTML = markdownToHtml(m.text);
      } else {
        el.textContent = m.text;
      }
      this.root.appendChild(el);
    }
    this.root.scrollTop = this.root.scrollHeight;
  }
}
