import { markdownToHtml, stripMarkdown } from "./markdown.js";

export type CaptionMessage =
  | { type: "start"; text: string }
  | { type: "reveal"; text: string }
  | { type: "end"; reason?: string };

/**
 * HUD caption state: full utterance with live reveal prefix.
 * Falls back to amplitude-driven reveal when word-alignment is sparse.
 * Assistant text is rendered as lightweight markdown (bold/lists/code).
 */
export class CaptionHud {
  private full = "";
  private revealed = "";
  private speaking = false;
  private energyAccum = 0;
  private readonly liveEl: HTMLElement;
  private readonly restEl: HTMLElement;
  private readonly cursorEl: HTMLElement;
  private readonly modeEl: HTMLElement;

  constructor(opts: {
    live: HTMLElement;
    rest: HTMLElement;
    cursor: HTMLElement;
    mode: HTMLElement;
  }) {
    this.liveEl = opts.live;
    this.restEl = opts.rest;
    this.cursorEl = opts.cursor;
    this.modeEl = opts.mode;
    this.render();
  }

  handle(msg: CaptionMessage): void {
    if (msg.type === "start") {
      this.full = msg.text;
      this.revealed = "";
      this.speaking = true;
      this.energyAccum = 0;
      this.modeEl.textContent = "TRANSMITTING";
      this.cursorEl.hidden = false;
      this.render();
      return;
    }
    if (msg.type === "reveal") {
      this.speaking = true;
      if (msg.text.length >= this.revealed.length) {
        this.revealed = msg.text;
      }
      if (!this.full) this.full = msg.text;
      this.modeEl.textContent = "TRANSMITTING";
      this.cursorEl.hidden = false;
      this.render();
      return;
    }
    // end
    if (this.full && this.revealed.length < this.full.length) {
      this.revealed = this.full;
    }
    this.speaking = false;
    this.modeEl.textContent = "STANDBY";
    this.cursorEl.hidden = true;
    this.render();
  }

  /** Nudge reveal forward from live audio energy when alignment packets lag. */
  onLevel(rms: number): void {
    if (!this.speaking || !this.full) return;
    if (this.revealed.length >= this.full.length) return;
    if (rms < 0.02) return;
    this.energyAccum += rms;
    // Rough chars-per-energy — keeps ghost text filling when TTS has no word events.
    const target = Math.min(
      this.full.length,
      this.revealed.length + Math.floor(this.energyAccum * 18),
    );
    if (target > this.revealed.length) {
      this.energyAccum *= 0.35;
      // Prefer word/space boundaries
      let end = target;
      while (end < this.full.length && !/\s/.test(this.full[end]!)) end += 1;
      this.revealed = this.full.slice(0, Math.max(this.revealed.length + 1, end));
      this.render();
    }
  }

  reset(): void {
    this.full = "";
    this.revealed = "";
    this.speaking = false;
    this.energyAccum = 0;
    this.modeEl.textContent = "STANDBY";
    this.cursorEl.hidden = true;
    this.render();
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  private render(): void {
    if (!this.full && !this.revealed) {
      this.liveEl.innerHTML = "";
      this.restEl.textContent = "Awaiting signal…";
      return;
    }
    // Live prefix: render markdown. Ghost remainder: plain (markers stripped).
    this.liveEl.innerHTML = markdownToHtml(this.revealed);
    this.restEl.textContent = stripMarkdown(this.full.slice(this.revealed.length));
    // Keep the newest spoken text in view without scrolling the page.
    const scroller = this.liveEl.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

export function parseCaptionPayload(data: Uint8Array): CaptionMessage | undefined {
  try {
    const raw = JSON.parse(new TextDecoder().decode(data)) as {
      channel?: string;
      type?: string;
      text?: string;
      reason?: string;
    };
    if (raw.channel && raw.channel !== "alfred.caption") return undefined;
    if (raw.type === "start" && typeof raw.text === "string") {
      return { type: "start", text: raw.text };
    }
    if (raw.type === "reveal" && typeof raw.text === "string") {
      return { type: "reveal", text: raw.text };
    }
    if (raw.type === "end") {
      return { type: "end", reason: raw.reason };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
