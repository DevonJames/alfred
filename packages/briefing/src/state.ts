import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BriefingOfferState {
  lastOfferedDay: string | null;
  lastDeclinedDay: string | null;
  lastPlayedDay: string | null;
  offerPending: boolean;
  /**
   * Bumped by resetSoftOffer so other voice processes (cascade / GPT-Live /
   * Speech Engine) re-arm after the Brief tab clears today's markers.
   */
  softOfferGeneration: number;
}

const DEFAULT_STATE: BriefingOfferState = {
  lastOfferedDay: null,
  lastDeclinedDay: null,
  lastPlayedDay: null,
  offerPending: false,
  softOfferGeneration: 0,
};

function normalizeState(parsed: Partial<BriefingOfferState>): BriefingOfferState {
  return {
    lastOfferedDay: parsed.lastOfferedDay ?? null,
    lastDeclinedDay: parsed.lastDeclinedDay ?? null,
    lastPlayedDay: parsed.lastPlayedDay ?? null,
    offerPending: Boolean(parsed.offerPending),
    softOfferGeneration:
      typeof parsed.softOfferGeneration === "number" && Number.isFinite(parsed.softOfferGeneration)
        ? Math.max(0, Math.floor(parsed.softOfferGeneration))
        : 0,
  };
}

export class BriefingStateStore {
  private cache: BriefingOfferState | null = null;

  constructor(readonly dir: string) {}

  get filePath(): string {
    return path.join(this.dir, "state.json");
  }

  async load(opts?: { refresh?: boolean }): Promise<BriefingOfferState> {
    if (this.cache && !opts?.refresh) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BriefingOfferState>;
      this.cache = normalizeState(parsed);
    } catch {
      this.cache = { ...DEFAULT_STATE };
    }
    return this.cache;
  }

  async save(state: BriefingOfferState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.cache = normalizeState(state);
    await writeFile(this.filePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
  }

  async update(patch: Partial<BriefingOfferState>): Promise<BriefingOfferState> {
    const cur = await this.load();
    const next = normalizeState({ ...cur, ...patch });
    await this.save(next);
    return next;
  }
}

/** Soft-offer eligibility for a briefing day key. */
export function isSoftOfferEligible(
  dayKey: string,
  state: BriefingOfferState,
): boolean {
  if (state.lastPlayedDay === dayKey) return false;
  if (state.lastOfferedDay === dayKey) return false;
  if (state.lastDeclinedDay === dayKey) return false;
  return true;
}
