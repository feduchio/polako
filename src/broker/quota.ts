import type { Clock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import type { Usage } from "./types.js";

export interface ProviderLimits {
  concurrency: number;
  /** requests per minute; null = unknown/unlimited */
  rpm: number | null;
}

export interface BudgetLimits {
  maxRunUsd: number | null;
  maxRunTokens: number | null;
  maxTaskTokens: number | null;
}

export interface BudgetSnapshot {
  /** Known USD only. Null provider prices never become zero. */
  runUsd: number;
  runTokens: number;
  perTask: Record<string, number>;
  unknownCostCalls: string[];
}

/**
 * Concurrency slots, a per-provider request-rate window, and provider cool-downs (from
 * 429 `retry-after`). Purely in-memory: quota state is not worth persisting.
 */
export class QuotaTracker {
  private readonly inFlight = new Map<string, number>();
  private readonly requestTimes = new Map<string, number[]>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly limits = new Map<string, ProviderLimits>();

  constructor(
    private readonly clock: Clock,
    private readonly defaultLimits: ProviderLimits,
  ) {}

  setLimits(providerId: string, limits: Partial<ProviderLimits>): void {
    this.limits.set(providerId, { ...this.defaultLimits, ...this.limitsFor(providerId), ...limits });
  }

  limitsFor(providerId: string): ProviderLimits {
    return this.limits.get(providerId) ?? this.defaultLimits;
  }

  coolDown(providerId: string, ms: number): void {
    this.cooldownUntil.set(providerId, Math.max(this.cooldownUntil.get(providerId) ?? 0, this.clock.now() + ms));
  }

  /** ms until the provider may be used again (0 = now). */
  availableIn(providerId: string): number {
    const now = this.clock.now();
    const cd = this.cooldownUntil.get(providerId) ?? 0;
    let wait = Math.max(0, cd - now);
    const { concurrency, rpm } = this.limitsFor(providerId);
    if ((this.inFlight.get(providerId) ?? 0) >= concurrency) wait = Math.max(wait, 50);
    if (rpm !== null) {
      const times = this.pruneWindow(providerId, now);
      if (times.length >= rpm) wait = Math.max(wait, (times[0] ?? now) + 60_000 - now);
    }
    return wait;
  }

  /** Acquire a slot, waiting as needed. Returns a release function. */
  async acquire(providerId: string, signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      if (signal?.aborted) throw new PolishError("CANCELLED", "cancelled while waiting for provider quota");
      const wait = this.availableIn(providerId);
      if (wait === 0) break;
      await this.clock.sleep(wait, signal);
    }
    this.inFlight.set(providerId, (this.inFlight.get(providerId) ?? 0) + 1);
    this.pruneWindow(providerId, this.clock.now()).push(this.clock.now());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.set(providerId, Math.max(0, (this.inFlight.get(providerId) ?? 1) - 1));
    };
  }

  inFlightCount(providerId: string): number {
    return this.inFlight.get(providerId) ?? 0;
  }

  private pruneWindow(providerId: string, now: number): number[] {
    const times = (this.requestTimes.get(providerId) ?? []).filter((t) => t > now - 60_000);
    this.requestTimes.set(providerId, times);
    return times;
  }
}

/**
 * Relative slack on the "one more call would exceed the limit" comparison. Sums of doubles land a
 * few units in the last place away from the decimal answer — 0.1 + 0.2 is 0.30000000000000004 —
 * and without this a $0.10 and a $0.20 hold do not fit a $0.30 limit. A billionth is orders of
 * magnitude below any price a provider quotes and orders of magnitude above the error of summing a
 * handful of terms.
 */
const BUDGET_SLACK = 1e-9;

/** Token/USD budgets per run and per task. Exceeding a budget throws before the call is made. */
export class BudgetTracker {
  private readonly runs = new Map<string, BudgetSnapshot>();
  private readonly runLimits = new Map<string, BudgetLimits>();
  /**
   * USD admitted but not yet charged, one entry per attempt in flight. A set of outstanding
   * holds rather than a running sum: adding and subtracting the same doubles does not return to
   * zero — 0.18 + 0.21 + 0.41 released in turn leaves 1.67e-16 behind, which refuses the run
   * forever. Summing what is still held is exact by construction, and the set is never larger
   * than the provider's concurrency.
   */
  private readonly reserved = new Map<string, Set<{ usd: number }>>();

  /**
   * `limits` are the daemon-wide defaults and are never written to: a run's own limits go
   * into `runLimits`. `resolveRunLimits` supplies them lazily for runs this process never
   * created, such as those recovered after a restart.
   */
  constructor(
    private readonly limits: BudgetLimits,
    private readonly resolveRunLimits?: (runId: string) => BudgetLimits | null,
  ) {}

  private limitsFor(runId: string): BudgetLimits {
    const registered = this.runLimits.get(runId);
    if (registered !== undefined) return registered;
    const resolved = this.resolveRunLimits?.(runId) ?? null;
    if (resolved === null) return this.limits;
    this.runLimits.set(runId, resolved);
    return resolved;
  }

  /**
   * A copy. The stored object is live enforcement state, so handing out the reference lets any
   * reader zero a run's spend by assigning to it — and `ModelBroker.budgetSnapshot` makes that
   * reference public.
   */
  snapshot(runId: string): BudgetSnapshot {
    const stored = this.runs.get(runId);
    if (stored === undefined) return { runUsd: 0, runTokens: 0, perTask: {}, unknownCostCalls: [] };
    return {
      runUsd: stored.runUsd,
      runTokens: stored.runTokens,
      perTask: { ...stored.perTask },
      unknownCostCalls: [...stored.unknownCostCalls],
    };
  }

  /** Restore from persisted usage (replayed `model.call` events). */
  restore(runId: string, snapshot: BudgetSnapshot): void {
    this.runs.set(runId, {
      runUsd: snapshot.runUsd,
      runTokens: snapshot.runTokens,
      perTask: { ...snapshot.perTask },
      unknownCostCalls: [...snapshot.unknownCostCalls],
    });
  }

  /**
   * Admit one call and hold what it may cost until its actual cost is recorded. Indivisible by
   * construction: asserting and then reserving in two steps is the defect it repairs, because two
   * callers reach the assertion before either reserves. The returned function releases the hold
   * and must run after `record`, or a window exists in which neither counts.
   */
  admit(runId: string, estimatedUsd: number, taskId?: string): () => void {
    const usd = Number.isFinite(estimatedUsd) && estimatedUsd > 0 ? estimatedUsd : 0;
    this.assertWithin(runId, taskId, usd);
    const holds = this.reserved.get(runId) ?? new Set<{ usd: number }>();
    const hold = { usd };
    holds.add(hold);
    this.reserved.set(runId, holds);
    return () => {
      holds.delete(hold);
      // A finished run must not leave a key behind: the daemon outlives thousands of them.
      if (holds.size === 0) this.reserved.delete(runId);
    };
  }

  private reservedFor(runId: string): number {
    let total = 0;
    for (const hold of this.reserved.get(runId) ?? []) total += hold.usd;
    return total;
  }

  /**
   * `incomingUsd` is what the call being admitted may cost. Two rules, and they are not the same
   * question: the budget is *exhausted* when what is already spent or promised has reached it, and
   * it is *insufficient* when one more call would take it past. Recorded spend alone answered
   * neither for a call in flight — ten $0.49 calls all passed a $0.50 limit and the run ended at
   * $4.90.
   */
  assertWithin(runId: string, taskId?: string, incomingUsd = 0): void {
    const s = this.snapshot(runId);
    const limits = this.limitsFor(runId);
    const committed = s.runUsd + this.reservedFor(runId);
    if (limits.maxRunUsd !== null && committed >= limits.maxRunUsd) {
      throw new PolishError("CONFLICT", "run USD budget exhausted", { runId, spent: committed, limit: limits.maxRunUsd, budget: "run_usd" });
    }
    if (limits.maxRunUsd !== null && committed + incomingUsd > limits.maxRunUsd * (1 + BUDGET_SLACK)) {
      // Distinct from exhaustion, and said differently: the run has money and this call is too
      // large for what is left. Reporting it as "exhausted" at a spend of $0 is how an operator
      // ends up looking for spend that never happened.
      throw new PolishError("CONFLICT", "run USD budget cannot cover the next call", {
        runId,
        spent: committed,
        estimate: incomingUsd,
        limit: limits.maxRunUsd,
        budget: "run_usd",
      });
    }
    if (limits.maxRunTokens !== null && s.runTokens >= limits.maxRunTokens) {
      throw new PolishError("CONFLICT", "run token budget exhausted", { runId, spent: s.runTokens, limit: limits.maxRunTokens, budget: "run_tokens" });
    }
    if (taskId !== undefined && limits.maxTaskTokens !== null && taskTokens(s.perTask, taskId) >= limits.maxTaskTokens) {
      throw new PolishError("CONFLICT", "task token budget exhausted", { runId, taskId, spent: taskTokens(s.perTask, taskId), limit: limits.maxTaskTokens, budget: "task_tokens" });
    }
  }

  record(runId: string, usage: Usage, taskId?: string, callId?: string): BudgetSnapshot {
    const previous = this.snapshot(runId);
    const s: BudgetSnapshot = {
      runUsd: previous.runUsd,
      runTokens: previous.runTokens,
      perTask: { ...previous.perTask },
      unknownCostCalls: [...previous.unknownCostCalls],
    };
    const tokens = usage.inputTokens + usage.outputTokens;
    s.runTokens += tokens;
    if (usage.costUsd === null) {
      const unknownId = callId ?? `unknown:${s.unknownCostCalls.length}`;
      if (!s.unknownCostCalls.includes(unknownId)) s.unknownCostCalls.push(unknownId);
    } else {
      s.runUsd += usage.costUsd;
    }
    if (taskId !== undefined) s.perTask = withTaskTokens(s.perTask, taskId, tokens);
    this.runs.set(runId, s);
    // A copy, for the same reason `snapshot` returns one: `s` is now live enforcement state.
    return this.snapshot(runId);
  }
}

/**
 * A task id reaches here from an event payload, and `perTask[taskId]` on a plain object is unsafe
 * for two of them: `__proto__` assigns the prototype and records nothing, while `constructor` reads
 * back as a function, so `>= maxTaskTokens` compares an object to a number and is always false —
 * the task would spend without limit. Finding 50.
 */
function taskTokens(perTask: Record<string, number>, taskId: string): number {
  return Object.hasOwn(perTask, taskId) ? perTask[taskId] ?? 0 : 0;
}

function withTaskTokens(perTask: Record<string, number>, taskId: string, tokens: number): Record<string, number> {
  return Object.fromEntries([...Object.entries(perTask), [taskId, taskTokens(perTask, taskId) + tokens]]);
}

export function isBudgetError(err: unknown): boolean {
  return err instanceof PolishError && err.code === "CONFLICT" && typeof err.details["budget"] === "string";
}
