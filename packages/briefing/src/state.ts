import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BriefingOfferState {
  lastOfferedDay: string | null;
  lastDeclinedDay: string | null;
  lastPlayedDay: string | null;
  offerPending: boolean;
}

const DEFAULT_STATE: BriefingOfferState = {
  lastOfferedDay: null,
  lastDeclinedDay: null,
  lastPlayedDay: null,
  offerPending: false,
};

export class BriefingStateStore {
  private cache: BriefingOfferState | null = null;

  constructor(readonly dir: string) {}

  get filePath(): string {
    return path.join(this.dir, "state.json");
  }

  async load(): Promise<BriefingOfferState> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BriefingOfferState>;
      this.cache = {
        lastOfferedDay: parsed.lastOfferedDay ?? null,
        lastDeclinedDay: parsed.lastDeclinedDay ?? null,
        lastPlayedDay: parsed.lastPlayedDay ?? null,
        offerPending: Boolean(parsed.offerPending),
      };
    } catch {
      this.cache = { ...DEFAULT_STATE };
    }
    return this.cache;
  }

  async save(state: BriefingOfferState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.cache = state;
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async update(patch: Partial<BriefingOfferState>): Promise<BriefingOfferState> {
    const cur = await this.load();
    const next = { ...cur, ...patch };
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
