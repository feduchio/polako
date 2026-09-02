export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Deterministic clock for simulations: time advances only via `advance()`/`tick()`.
 * Sleeps resolve in timestamp order when time passes them.
 */
export class FakeClock implements Clock {
  private current: number;
  private waiters: { at: number; seq: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  private seq = 0;

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const waiter = { at: this.current + Math.max(0, ms), seq: this.seq++, resolve, reject };
      this.waiters.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(abortError(signal));
        },
        { once: true },
      );
    });
  }

  /**
   * Advance time by `ms`, firing due sleepers in order. Drains pending continuations *before*
   * moving time (so a sleep scheduled by code that is already running registers at the
   * pre-advance time), between firings, and after reaching the target (re-entrancy).
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (let guard = 0; ; guard++) {
      if (guard > 100_000) throw new Error("FakeClock.advance: sleepers keep re-registering at the current time");
      await flushMicrotasks();
      const due = this.waiters
        .filter((w) => w.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due) {
        this.current = Math.max(this.current, due.at);
        this.waiters = this.waiters.filter((w) => w !== due);
        due.resolve();
        continue;
      }
      if (this.current !== target) {
        this.current = target;
        continue;
      }
      break;
    }
  }

  pendingSleepers(): number {
    return this.waiters.length;
  }
}

/** Drain the microtask queue completely (a macrotask boundary), `rounds` times. */
export async function flushMicrotasks(rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
