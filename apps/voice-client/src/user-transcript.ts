export type UserTranscriptMessage =
  | { type: "partial"; text: string }
  | { type: "final"; text: string };

/** YOU // MIC panel — live STT from the agent. */
export class UserTranscriptHud {
  private text = "";
  private final = false;
  private readonly textEl: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly cursorEl: HTMLElement;
  private readonly rootEl: HTMLElement;

  constructor(opts: {
    root: HTMLElement;
    text: HTMLElement;
    mode: HTMLElement;
    cursor: HTMLElement;
  }) {
    this.rootEl = opts.root;
    this.textEl = opts.text;
    this.modeEl = opts.mode;
    this.cursorEl = opts.cursor;
    this.render();
  }

  handle(msg: UserTranscriptMessage): void {
    this.text = msg.text;
    this.final = msg.type === "final";
    this.modeEl.textContent = this.final ? "LOCKED" : "LISTENING";
    this.rootEl.classList.toggle("active", true);
    this.rootEl.classList.toggle("final", this.final);
    this.cursorEl.hidden = this.final;
    this.render();
  }

  reset(): void {
    this.text = "";
    this.final = false;
    this.modeEl.textContent = "IDLE";
    this.rootEl.classList.remove("active", "final");
    this.cursorEl.hidden = true;
    this.render();
  }

  private render(): void {
    this.textEl.textContent = this.text || "Speak to uplink…";
    this.textEl.classList.toggle("placeholder", !this.text);
  }
}

export function parseUserTranscriptPayload(data: Uint8Array): UserTranscriptMessage | undefined {
  try {
    const raw = JSON.parse(new TextDecoder().decode(data)) as {
      channel?: string;
      type?: string;
      text?: string;
    };
    if (raw.channel && raw.channel !== "alfred.user") return undefined;
    if ((raw.type === "partial" || raw.type === "final") && typeof raw.text === "string") {
      return { type: raw.type, text: raw.text };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
