/**
 * Model residency for a server that keeps one large model in memory at a time (LM Studio on a
 * 48 GB Mac). A swap costs 10-20 s, so the scheduler runs one call at a time, serves every queued
 * call for the resident model before it swaps, and never lets two loads overlap: `run` and
 * `unloadAll` are the only ways to change what is loaded, and both go through one queue.
 */

/** A model instance the server has loaded, as the server names it. */
export interface ResidentInstance {
  /** the name requests use; equals `modelKey` for instances this scheduler loaded itself */
  identifier: string;
  modelKey: string;
}

/** What the scheduler needs from the server; `lms` or its REST API implement it. */
export interface ResidencyControl {
  loaded(signal?: AbortSignal): Promise<ResidentInstance[]>;
  load(modelKey: string, identifier: string, signal?: AbortSignal): Promise<void>;
  unload(identifier: string, signal?: AbortSignal): Promise<void>;
}

export type ResidencyEvent =
  | { type: "swap"; from: string | null; to: string; ms: number }
  | { type: "unloaded_all"; count: number };

export interface ResidencyOptions {
  control: ResidencyControl;
  now?: () => number;
  /** Calls served for the resident model in a row before the oldest waiting call goes first. */
  maxBatch?: number;
  /** A call that has waited this long goes next even if it costs a swap. */
  maxWaitMs?: number;
  /** How long the scheduler trusts its picture of what is loaded before asking the server again. */
  recheckMs?: number;
  onEvent?: (event: ResidencyEvent) => void;
}

export interface ResidencyStats {
  resident: string | null;
  queued: number;
  served: number;
  swaps: number;
}

interface Job {
  kind: "call" | "unload_all";
  model: string;
  enqueuedAt: number;
  signal: AbortSignal | undefined;
  start: (identifier: string) => Promise<void>;
  fail: (error: unknown) => void;
}

export const DEFAULT_MAX_BATCH = 32;
export const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
export const DEFAULT_RECHECK_MS = 30_000;

export class ResidencyScheduler {
  private readonly control: ResidencyControl;
  private readonly now: () => number;
  private readonly maxBatch: number;
  private readonly maxWaitMs: number;
  private readonly recheckMs: number;
  private readonly onEvent: ((event: ResidencyEvent) => void) | undefined;
  private readonly queue: Job[] = [];
  private pumping = false;
  /** What the server has loaded, or null when unknown; refreshed at `syncedAt`. */
  private instances: ResidentInstance[] | null = null;
  private syncedAt = 0;
  private servedSinceSwap = 0;
  private served = 0;
  private swaps = 0;

  constructor(options: ResidencyOptions) {
    this.control = options.control;
    this.now = options.now ?? Date.now;
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
    this.onEvent = options.onEvent;
  }

  /**
   * Run `fn` with `modelKey` resident; `fn` receives the name to put in the request. Calls queue
   * behind the one running, and the next one served is chosen by `pickNext`, not by arrival.
   */
  run<T>(modelKey: string, fn: (identifier: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueue({
        kind: "call",
        model: modelKey,
        enqueuedAt: this.now(),
        signal,
        start: async (identifier) => {
          try {
            resolve(await fn(identifier));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        fail: reject,
      });
    });
  }

  /** Unload everything, after every call queued before this one. */
  unloadAll(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.enqueue({
        kind: "unload_all",
        model: "",
        enqueuedAt: this.now(),
        signal: undefined,
        start: async () => {
          try {
            await this.doUnloadAll();
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        fail: reject,
      });
    });
  }

  stats(): ResidencyStats {
    return { resident: this.residentKey(), queued: this.queue.length, served: this.served, swaps: this.swaps };
  }

  private enqueue(job: Job): void {
    if (job.signal?.aborted) {
      job.fail(abortError());
      return;
    }
    this.queue.push(job);
    job.signal?.addEventListener(
      "abort",
      () => {
        const at = this.queue.indexOf(job);
        if (at < 0) return;
        this.queue.splice(at, 1);
        job.fail(abortError());
      },
      { once: true },
    );
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const index = this.pickNext();
        if (index < 0) return;
        const [job] = this.queue.splice(index, 1);
        if (job === undefined) return;
        if (job.kind === "unload_all") {
          await job.start("");
          continue;
        }
        let identifier: string;
        try {
          identifier = await this.ensureResident(job.model, job.signal);
        } catch (error) {
          // The picture of the server may be wrong now; the next call asks again.
          this.instances = null;
          job.fail(error);
          continue;
        }
        this.served += 1;
        this.servedSinceSwap += 1;
        await job.start(identifier);
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Index of the next job. Arrival order, except that jobs for the resident model go first: until
   * `maxBatch` of them ran in a row, or the oldest job has waited `maxWaitMs`, or the oldest is a
   * barrier (`unloadAll`), which nothing queued behind it may overtake.
   */
  private pickNext(): number {
    const oldest = this.queue[0];
    if (oldest === undefined) return -1;
    if (oldest.kind === "unload_all") return 0;
    const resident = this.residentKey();
    if (resident === null || oldest.model === resident) return 0;
    if (this.servedSinceSwap >= this.maxBatch || this.now() - oldest.enqueuedAt >= this.maxWaitMs) return 0;
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i];
      if (job === undefined || job.kind === "unload_all") break;
      if (job.model === resident) return i;
    }
    return 0;
  }

  private residentKey(): string | null {
    return this.instances?.length === 1 ? (this.instances[0]?.modelKey ?? null) : null;
  }

  private async sync(signal?: AbortSignal): Promise<ResidentInstance[]> {
    if (this.instances === null || this.now() - this.syncedAt >= this.recheckMs) {
      this.instances = await this.control.loaded(signal);
      this.syncedAt = this.now();
    }
    return this.instances;
  }

  /** Make `modelKey` the only loaded model and return the name requests must use for it. */
  private async ensureResident(modelKey: string, signal?: AbortSignal): Promise<string> {
    const current = await this.sync(signal);
    const wanted = current.find((instance) => instance.modelKey === modelKey);
    if (wanted !== undefined && current.length === 1) return wanted.identifier;

    const started = this.now();
    const previous = current.find((instance) => instance !== wanted)?.modelKey ?? null;
    // Everything else goes first: with one large model in memory a second never fits beside it.
    for (const instance of current) {
      if (instance === wanted) continue;
      await this.control.unload(instance.identifier, signal);
      this.instances = current.filter((other) => other !== instance);
    }
    if (wanted !== undefined) {
      this.instances = [wanted];
      return wanted.identifier;
    }
    await this.control.load(modelKey, modelKey, signal);
    this.instances = [{ identifier: modelKey, modelKey }];
    this.syncedAt = this.now();
    this.servedSinceSwap = 0;
    this.swaps += 1;
    this.onEvent?.({ type: "swap", from: previous, to: modelKey, ms: this.now() - started });
    return modelKey;
  }

  private async doUnloadAll(): Promise<void> {
    this.instances = null;
    const current = await this.sync();
    for (const instance of current) await this.control.unload(instance.identifier);
    this.instances = [];
    this.syncedAt = this.now();
    this.servedSinceSwap = 0;
    this.onEvent?.({ type: "unloaded_all", count: current.length });
  }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
