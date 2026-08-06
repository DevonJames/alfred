export interface Clock {
  now(): number;
  nowIso(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date(this.now()).toISOString();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Deterministic clock for tests and the simulator. */
export class FakeClock implements Clock {
  private t: number;
  private readonly waiters: Array<{
    at: number;
    resolve: () => void;
    reject: (err: unknown) => void;
    signal?: AbortSignal;
  }> = [];

  constructor(startMs = Date.parse("2026-01-01T00:00:00.000Z")) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  nowIso(): string {
    return new Date(this.t).toISOString();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    return new Promise<void>((resolve, reject) => {
      const waiter = { at: this.t + ms, resolve, reject, signal };
      this.waiters.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  /** Advance time and resolve due sleepers. */
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.waiters.filter((w) => w.at <= this.t).sort((a, b) => a.at - b.at);
    for (const w of due) {
      const idx = this.waiters.indexOf(w);
      if (idx >= 0) this.waiters.splice(idx, 1);
      w.resolve();
    }
    // Allow microtasks from resolved sleepers to run.
    await Promise.resolve();
  }

  set(ms: number): void {
    this.t = ms;
  }
}
