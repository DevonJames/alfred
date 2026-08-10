import type { OipLocalMemoryProvider } from "@alfred/memory";
import { loadBriefingConfig, type BriefingConfig } from "./config.js";
import { getBriefingDayKey } from "./day.js";
import { generateBriefing, type GenerateBriefingOptions } from "./generate.js";
import type { GreetingLlm } from "./greeting.js";
import { detectBriefingIntent, type BriefingIntentKind } from "./intent.js";
import { BriefingStateStore, isSoftOfferEligible } from "./state.js";
import type { BriefingPayload } from "./types.js";

export const BRIEFING_OFFER_CLOSER = "Would you like the daily briefing now?";
export const BRIEFING_DECLINE_ACK = "Alright.";
export const BRIEFING_OFFER_SYSTEM_HINT =
  "This is the first conversation of the user's briefing day. Keep your answer concise (1-2 short sentences). A separate offer for the daily briefing will be appended after your reply — do not mention the briefing yourself.";

export type BriefingTurnDecision =
  | { action: "play"; speech: string; payload: BriefingPayload }
  | { action: "decline"; speech: string }
  | { action: "chat"; appendOffer: boolean; systemHint?: string };

/**
 * Facade for voice + HTTP. Safe to construct once per voice process.
 */
export class BriefingController {
  readonly config: BriefingConfig;
  readonly state: BriefingStateStore;
  private firstTurnOfProcess = true;
  private offeredThisProcess = false;

  constructor(
    private readonly memory: OipLocalMemoryProvider | null,
    config?: Partial<BriefingConfig>,
    private readonly llm?: GreetingLlm | null,
  ) {
    this.config = loadBriefingConfig(config);
    this.state = new BriefingStateStore(this.config.stateDir);
  }

  get offerCloser(): string {
    return BRIEFING_OFFER_CLOSER;
  }

  get declineAck(): string {
    return BRIEFING_DECLINE_ACK;
  }

  get offerSystemHint(): string {
    return BRIEFING_OFFER_SYSTEM_HINT;
  }

  async detectIntent(text: string): Promise<BriefingIntentKind> {
    const st = await this.state.load();
    return detectBriefingIntent(text, st.offerPending);
  }

  async shouldSoftOffer(now = new Date()): Promise<boolean> {
    if (!this.firstTurnOfProcess) return false;
    if (this.offeredThisProcess) return false;
    const dayKey = getBriefingDayKey(now, this.config.timezone, this.config.dayStart);
    const st = await this.state.load();
    return isSoftOfferEligible(dayKey, st);
  }

  /** Call after handling a committed user turn (whether or not we offered). */
  noteUserTurnSeen(): void {
    this.firstTurnOfProcess = false;
  }

  async markOffered(now = new Date()): Promise<void> {
    const dayKey = getBriefingDayKey(now, this.config.timezone, this.config.dayStart);
    this.offeredThisProcess = true;
    this.firstTurnOfProcess = false;
    await this.state.update({
      lastOfferedDay: dayKey,
      offerPending: true,
    });
  }

  async markDeclined(now = new Date()): Promise<void> {
    const dayKey = getBriefingDayKey(now, this.config.timezone, this.config.dayStart);
    this.firstTurnOfProcess = false;
    await this.state.update({
      lastDeclinedDay: dayKey,
      offerPending: false,
    });
  }

  async markPlayed(now = new Date()): Promise<void> {
    const dayKey = getBriefingDayKey(now, this.config.timezone, this.config.dayStart);
    this.firstTurnOfProcess = false;
    await this.state.update({
      lastPlayedDay: dayKey,
      offerPending: false,
    });
  }

  async generate(opts: { refresh?: boolean; markSurfaced?: boolean; now?: Date } = {}): Promise<BriefingPayload> {
    return generateBriefing({
      config: this.config,
      memory: this.memory,
      llm: this.llm,
      refresh: opts.refresh,
      markSurfaced: opts.markSurfaced,
      now: opts.now,
    });
  }

  /**
   * Voice entry: classify turn and either play briefing, decline, or continue chat
   * (optionally with soft-offer append).
   */
  async handleUserTurn(text: string, now = new Date()): Promise<BriefingTurnDecision> {
    const intent = await this.detectIntent(text);

    if (intent === "explicitAsk" || intent === "affirmOffer") {
      const payload = await this.generate({ refresh: true, markSurfaced: true, now });
      await this.markPlayed(now);
      return { action: "play", speech: payload.speech, payload };
    }

    if (intent === "declineOffer") {
      await this.markDeclined(now);
      return { action: "decline", speech: this.declineAck };
    }

    const offer = await this.shouldSoftOffer(now);
    if (offer) {
      await this.markOffered(now);
      return {
        action: "chat",
        appendOffer: true,
        systemHint: this.offerSystemHint,
      };
    }
    this.noteUserTurnSeen();
    return { action: "chat", appendOffer: false };
  }
}

export function createBriefingController(opts: {
  memory?: OipLocalMemoryProvider | null;
  config?: Partial<BriefingConfig>;
  llm?: GreetingLlm | null;
}): BriefingController {
  return new BriefingController(opts.memory ?? null, opts.config, opts.llm);
}

export type { GenerateBriefingOptions };
