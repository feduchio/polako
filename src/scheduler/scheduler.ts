import type { LaneLimits } from "../domain/config.js";
import type { NewEvent } from "../domain/event.js";
import { assertTransition, isTerminal } from "../domain/fsm.js";
import { JOB_TABLE, type Job, type JobState, type Lane } from "../domain/job.js";
import { mayDispatchJobs, mustCancelInFlight, RUN_PHASE_TABLE, type RunControl } from "../domain/run.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { Store } from "../store/index.js";
import type { Clock } from "../shared/clock.js";
import { PolishError, errorToString, isAbortError } from "../shared/errors.js";
import { id } from "../shared/ids.js";

export interface JobContext {
  job: Job;
  signal: AbortSignal;
  store: Store;
  clock: Clock;
  /** extend the lease; long-running handlers call this periodically */
  heartbeat(): void;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | undefined>;

export interface EnqueueInput {
  runId: string;
  type: string;
  lane: Lane;
  payload?: Record<string, unknown>;
  dependsOn?: string[];
  priority?: number;
  maxAttempts?: number;
  /** event ids that caused this job (why-chain) */
  causedBy?: string[];
}

export interface SchedulerOptions {
  workerId: string;
  laneLimits: LaneLimits;
  /** per-provider llm lane overrides: lane name -> limit */
  laneOverrides?: Record<string, number>;
  leaseMs: number;
  /**
   * Called when a job's terminal state could not be persisted (store failure). The job stays
   * RUNNING in the store and will be reclaimed when its lease expires. Exceptions thrown by
   * the callback (or rejections, if it is async) are swallowed. The failure is always also
   * queued in `drainPersistErrors()`.
   */
  onPersistError?: (error: unknown, job: Job) => void | Promise<void>;
}

export interface PersistError {
  job: Job;
  error: unknown;
  at: number;
}

interface InFlight {
  job: Job;
  controller: AbortController;
  promise: Promise<void>;
}

/** Realm-independent promise detection (`instanceof Promise` fails for vm-created promises). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Persistent job scheduler. All job state lives in the store (events + `jobs` projection);
 * the in-memory part is only the set of in-flight promises. A crashed process leaves RUNNING
 * rows with leases; `recover()` returns them to READY.
 *
 * Dispatch respects: lane capacity, run control (only RUNNING runs dispatch), dependencies,
 * priority then FIFO. `tick()` is explicit so tests drive it with a FakeClock.
 */
export class Scheduler {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly controlCache = new Map<string, RunControl | null>();
  private persistErrors: PersistError[] = [];

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly options: SchedulerOptions,
  ) {}

  register(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) throw new PolishError("CONFLICT", `handler for ${type} already registered`);
    this.handlers.set(type, handler);
  }

  enqueue(input: EnqueueInput): Job {
    const now = this.clock.now();
    if (!this.store.repos.runs.get(input.runId)) throw new PolishError("NOT_FOUND", `run ${input.runId} not found`);
    const deps = input.dependsOn ?? [];
    const depsDone = deps.every((d) => this.store.repos.jobs.get(d)?.state === "SUCCEEDED");
    const job: Job = {
      id: id("job", now),
      runId: input.runId,
      type: input.type,
      lane: input.lane,
      payload: input.payload ?? {},
      dependsOn: deps,
      priority: input.priority ?? 0,
      state: deps.length === 0 || depsDone ? "READY" : "PENDING",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 1,
      leaseOwner: null,
      leaseUntil: null,
      cancelRequested: false,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.events.append([this.event(job, "job.created", input.causedBy ?? [])]);
    return job;
  }

  /**
   * Called once on startup. Every RUNNING job that this process is not executing is orphaned
   * (the previous process died — commonly with the *same* workerId), whatever its lease says:
   * v1 runs a single daemon per home, so nobody else can legitimately own a lease.
   */
  recover(): Job[] {
    const reclaimed: Job[] = [];
    for (const job of this.store.repos.jobs.listByState(["RUNNING"])) {
      if (this.inFlight.has(job.id)) continue;
      reclaimed.push(this.reclaim(job, "orphaned by previous process"));
    }
    return reclaimed;
  }

  /** Return an orphaned RUNNING job to READY, or FAILED when its attempt budget is spent. */
  private reclaim(job: Job, reason: string): Job {
    return job.attempts >= job.maxAttempts
      ? this.setState(job, "FAILED", { error: `${reason}; attempts exhausted`, leaseOwner: null, leaseUntil: null })
      : this.setState(job, "READY", { error: reason, leaseOwner: null, leaseUntil: null });
  }

  /**
   * One scheduling round: promote dependents, cascade cancellations, reclaim expired
   * leases, apply run control, dispatch READY jobs within lane capacity.
   */
  tick(): Job[] {
    const now = this.clock.now();
    this.controlCache.clear();
    this.promoteAndCascade();
    this.reclaimExpiredLeases(now);
    this.applyRunControl();

    const dispatched: Job[] = [];
    const running = this.laneUsage();
    const ready = this.store.repos.jobs.listByState(["READY"]);
    for (const job of ready) {
      if (job.cancelRequested) {
        this.setState(job, "CANCELLED", { error: "cancelled before start" });
        continue;
      }
      const control = this.controlFor(job.runId);
      if (control === null || !mayDispatchJobs(control)) continue; // vanished runs were failed in applyRunControl
      const run = this.store.repos.runs.get(job.runId);
      if (run === null || isTerminal(RUN_PHASE_TABLE, run.phase)) continue;
      const used = running.get(job.lane) ?? 0;
      if (used >= this.laneLimit(job.lane)) continue;
      if (!this.handlers.has(job.type)) {
        this.setState(job, "FAILED", { error: `no handler registered for job type ${job.type}` });
        continue;
      }
      running.set(job.lane, used + 1);
      dispatched.push(this.dispatch(job, now));
    }
    return dispatched;
  }

  /** Request cancellation of one job: aborts it if in flight, or cancels it before start. */
  cancelJob(jobId: string, reason = "cancelled"): void {
    const job = this.store.repos.jobs.get(jobId);
    if (!job) throw new PolishError("NOT_FOUND", `job ${jobId} not found`);
    if (JOB_TABLE.terminal.includes(job.state)) return;
    const flying = this.inFlight.get(jobId);
    if (flying) {
      this.markCancelRequested(job);
      flying.controller.abort(new PolishError("CANCELLED", reason));
      return;
    }
    this.setState(job, "CANCELLED", { error: reason });
  }

  /** Cancel every non-terminal job of a run (stop/kill). */
  cancelRun(runId: string, reason = "run cancelled"): number {
    let n = 0;
    for (const job of this.store.repos.jobs.listByState(["PENDING", "READY", "RUNNING"], runId)) {
      this.cancelJob(job.id, reason);
      n++;
    }
    return n;
  }

  /** Resolves when no jobs are in flight (optionally for one run). Used by pause (drain) and shutdown. */
  async settle(runId?: string): Promise<void> {
    for (;;) {
      const pending = [...this.inFlight.values()].filter((f) => runId === undefined || f.job.runId === runId);
      if (pending.length === 0) return;
      await Promise.allSettled(pending.map((f) => f.promise));
    }
  }

  /** Terminal-state writes that failed since the last drain (see `onPersistError`). */
  drainPersistErrors(): PersistError[] {
    const out = this.persistErrors;
    this.persistErrors = [];
    return out;
  }

  inFlightCount(runId?: string): number {
    return [...this.inFlight.values()].filter((f) => runId === undefined || f.job.runId === runId).length;
  }

  private dispatch(job: Job, now: number): Job {
    const handler = this.handlers.get(job.type);
    if (!handler) throw new PolishError("INVARIANT_VIOLATION", "dispatch without handler");
    const running = this.setState(job, "RUNNING", {
      attempts: job.attempts + 1,
      leaseOwner: this.options.workerId,
      leaseUntil: now + this.options.leaseMs,
      error: null,
    });
    const controller = new AbortController();
    const ctx: JobContext = {
      job: running,
      signal: controller.signal,
      store: this.store,
      clock: this.clock,
      heartbeat: () => {
        this.renewLease(running.id);
      },
    };
    // Register before invoking: a handler that throws synchronously completes `runHandler`
    // before it returns, and the `finally` must find (and remove) the entry.
    const entry: InFlight = { job: running, controller, promise: Promise.resolve() };
    this.inFlight.set(running.id, entry);
    entry.promise = this.runHandler(running, handler, ctx, controller);
    return running;
  }

  private async runHandler(job: Job, handler: JobHandler, ctx: JobContext, controller: AbortController): Promise<void> {
    let outcome: { state: JobState; patch: Partial<Job> };
    try {
      const result = await handler(ctx);
      outcome = controller.signal.aborted
        ? { state: "CANCELLED", patch: { error: "cancelled" } }
        : { state: "SUCCEEDED", patch: { result: result ?? {} } };
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        outcome = { state: "CANCELLED", patch: { error: errorToString(err) } };
      } else if (job.attempts < job.maxAttempts) {
        outcome = { state: "READY", patch: { error: errorToString(err) } };
      } else {
        outcome = { state: "FAILED", patch: { error: errorToString(err) } };
      }
    }
    try {
      const current = this.store.repos.jobs.get(job.id);
      if (current?.state === "RUNNING") {
        this.setState(current, outcome.state, { ...outcome.patch, leaseOwner: null, leaseUntil: null });
      }
    } catch (err) {
      // The job stays RUNNING in the store; lease expiry will reclaim it. Never let this
      // become an unhandled rejection: `settle()` awaits these promises.
      this.persistErrors.push({ job, error: err, at: this.clock.now() });
      try {
        // A reporter may be async despite the void signature; swallow rejections too.
        const maybePromise: unknown = this.options.onPersistError?.(err, job);
        if (isThenable(maybePromise)) maybePromise.then(undefined, () => undefined);
      } catch {
        /* reporter failures must not escape */
      }
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private promoteAndCascade(): void {
    for (const job of this.store.repos.jobs.listByState(["PENDING"])) {
      if (job.cancelRequested) {
        this.setState(job, "CANCELLED", { error: "cancelled before start" });
        continue;
      }
      const deps = job.dependsOn.map((d) => this.store.repos.jobs.get(d));
      if (deps.some((d) => d === null || d.state === "FAILED" || d.state === "CANCELLED")) {
        this.setState(job, "CANCELLED", { error: "dependency failed or cancelled" });
        continue;
      }
      if (deps.every((d) => d?.state === "SUCCEEDED")) this.setState(job, "READY", {});
    }
  }

  private reclaimExpiredLeases(now: number): void {
    for (const job of this.store.repos.jobs.listByState(["RUNNING"])) {
      if (this.inFlight.has(job.id)) continue;
      if (job.leaseUntil !== null && job.leaseUntil >= now) continue;
      this.reclaim(job, "lease expired");
    }
  }

  /**
   * Stop/kill aborts in-flight work and cancels queued work. A run whose projection has
   * vanished is treated the same way (its jobs must not linger), with a distinct reason.
   */
  private applyRunControl(): void {
    for (const flying of [...this.inFlight.values()]) {
      const control = this.controlFor(flying.job.runId);
      if (flying.controller.signal.aborted) continue;
      if (control === null || mustCancelInFlight(control)) {
        this.markCancelRequested(flying.job);
        flying.controller.abort(new PolishError("CANCELLED", control === null ? "run not found" : "run stopped"));
      }
    }
    for (const job of this.store.repos.jobs.listByState(["PENDING", "READY"])) {
      const control = this.controlFor(job.runId);
      if (control === null) this.setState(job, "CANCELLED", { error: `run ${job.runId} not found` });
      else if (mustCancelInFlight(control)) this.setState(job, "CANCELLED", { error: "run stopped" });
    }
  }

  /** Run control, or null when the run does not exist (its jobs must never dispatch). */
  private controlFor(runId: string): RunControl | null {
    const cached = this.controlCache.get(runId);
    if (cached !== undefined) return cached;
    const control = this.store.repos.runs.get(runId)?.control ?? null;
    this.controlCache.set(runId, control);
    return control;
  }

  private laneUsage(): Map<string, number> {
    const usage = new Map<string, number>();
    for (const job of this.store.repos.jobs.listByState(["RUNNING"])) usage.set(job.lane, (usage.get(job.lane) ?? 0) + 1);
    return usage;
  }

  private laneLimit(lane: Lane): number {
    const override = this.options.laneOverrides?.[lane];
    if (override !== undefined) return override;
    if (lane.startsWith("llm.")) return this.options.laneLimits["llm.default"];
    const limits = this.options.laneLimits as unknown as Record<string, number>;
    return limits[lane] ?? 1;
  }

  private renewLease(jobId: string): void {
    const now = this.clock.now();
    this.store.db
      .prepare("UPDATE jobs SET lease_until = ?, json = json_set(json, '$.leaseUntil', ?) WHERE id = ? AND state = 'RUNNING'")
      .run(now + this.options.leaseMs, now + this.options.leaseMs, jobId);
  }

  private markCancelRequested(job: Job): void {
    this.store.db
      .prepare("UPDATE jobs SET json = json_set(json, '$.cancelRequested', json('true')) WHERE id = ?")
      .run(job.id);
  }

  private setState(job: Job, to: JobState, patch: Partial<Job>): Job {
    assertTransition(JOB_TABLE, `job ${job.id}`, job.state, to);
    const next: Job = { ...job, ...patch, state: to, updatedAt: this.clock.now() };
    this.store.events.append([this.event(next, "job.state_changed", [])]);
    return next;
  }

  private event(job: Job, type: "job.created" | "job.state_changed", causedBy: string[]): NewEvent {
    return {
      id: id("evt", this.clock.now()),
      runId: job.runId,
      ts: this.clock.now(),
      type,
      payload: { job },
      causedBy,
      actor: SYSTEM_ACTOR,
      artifacts: [],
    };
  }
}
