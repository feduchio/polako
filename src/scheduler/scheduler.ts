import type { LaneLimits } from "../domain/config.js";
import type { NewEvent } from "../domain/event.js";
import { assertTransition } from "../domain/fsm.js";
import { JOB_TABLE, type Job, type JobState, type Lane } from "../domain/job.js";
import { mayDispatchJobs, mustCancelInFlight, type RunControl } from "../domain/run.js";
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
}

interface InFlight {
  job: Job;
  controller: AbortController;
  promise: Promise<void>;
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
  private readonly controlCache = new Map<string, RunControl>();

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

  /** Called once on startup: reclaim jobs left RUNNING by a previous process or an expired lease. */
  recover(): Job[] {
    const now = this.clock.now();
    const reclaimed: Job[] = [];
    for (const job of this.store.repos.jobs.listByState(["RUNNING"])) {
      if (this.inFlight.has(job.id)) continue;
      const foreign = job.leaseOwner !== this.options.workerId;
      const expired = job.leaseUntil === null || job.leaseUntil < now;
      if (!foreign && !expired) continue;
      reclaimed.push(this.setState(job, "READY", { leaseOwner: null, leaseUntil: null }));
    }
    return reclaimed;
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
      if (!mayDispatchJobs(this.controlFor(job.runId))) continue;
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
    const promise = this.runHandler(running, handler, ctx, controller);
    this.inFlight.set(running.id, { job: running, controller, promise });
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
    } finally {
      this.inFlight.delete(job.id);
    }
    const current = this.store.repos.jobs.get(job.id);
    if (current?.state !== "RUNNING") return;
    this.setState(current, outcome.state, { ...outcome.patch, leaseOwner: null, leaseUntil: null });
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
      if (job.attempts >= job.maxAttempts) {
        this.setState(job, "FAILED", { error: "lease expired and attempts exhausted", leaseOwner: null, leaseUntil: null });
      } else {
        this.setState(job, "READY", { error: "lease expired", leaseOwner: null, leaseUntil: null });
      }
    }
  }

  private applyRunControl(): void {
    for (const flying of [...this.inFlight.values()]) {
      if (mustCancelInFlight(this.controlFor(flying.job.runId)) && !flying.controller.signal.aborted) {
        this.markCancelRequested(flying.job);
        flying.controller.abort(new PolishError("CANCELLED", "run stopped"));
      }
    }
    for (const job of this.store.repos.jobs.listByState(["PENDING", "READY"])) {
      if (mustCancelInFlight(this.controlFor(job.runId))) this.setState(job, "CANCELLED", { error: "run stopped" });
    }
  }

  private controlFor(runId: string): RunControl {
    const cached = this.controlCache.get(runId);
    if (cached) return cached;
    const run = this.store.repos.runs.get(runId);
    const control: RunControl = run?.control ?? "RUNNING";
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
