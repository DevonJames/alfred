import type { CaptionMessage } from "./captions.js";
import { markdownToHtml } from "./markdown.js";

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
};

/** In-memory conversation thread rendered into a single DOM root. */
export class TranscriptThread {
  private messages: ThreadMessage[] = [];
  private seq = 0;
  private assistantId?: string;

  constructor(private readonly root: HTMLElement) {
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
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user" && last.text === trimmed) return;
    this.messages.push({ id: `user_${++this.seq}`, role: "user", text: trimmed });
    this.assistantId = undefined;
    this.render();
  }

  handleCaption(msg: CaptionMessage): void {
    if (msg.type === "start") {
      this.assistantId = `asst_${++this.seq}`;
      this.messages.push({
        id: this.assistantId,
        role: "assistant",
        text: msg.text,
        streaming: true,
      });
      this.render();
      return;
    }
    if (msg.type === "reveal") {
      const current = this.currentAssistant();
      if (current) {
        current.text = msg.text;
        current.streaming = true;
      } else {
        this.assistantId = `asst_${++this.seq}`;
        this.messages.push({
          id: this.assistantId,
          role: "assistant",
          text: msg.text,
          streaming: true,
        });
      }
      this.render();
      return;
    }
    const current = this.currentAssistant();
    if (current) current.streaming = false;
    this.assistantId = undefined;
    this.render();
  }

  reset(): void {
    this.messages = [];
    this.assistantId = undefined;
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
