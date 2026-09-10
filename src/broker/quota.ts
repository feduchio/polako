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

/** Token/USD budgets per run and per task. Exceeding a budget throws before the call is made. */
export class BudgetTracker {
  private readonly runs = new Map<string, BudgetSnapshot>();
  private readonly runLimits = new Map<string, BudgetLimits>();

  /**
   * `limits` are the daemon-wide defaults and are never written to: a run's own limits go
   * into `runLimits`. `resolveRunLimits` supplies them lazily for runs this process never
   * created, such as those recovered after a restart.
   */
  constructor(
    private readonly limits: BudgetLimits,
    private readonly resolveRunLimits?: (runId: string) => BudgetLimits | null,
  ) {}

  /** Registers one run's own limits. Later calls for that run enforce these. */
  setRunLimits(runId: string, limits: BudgetLimits): void {
    this.runLimits.set(runId, limits);
  }

  limitsFor(runId: string): BudgetLimits {
    const registered = this.runLimits.get(runId);
    if (registered !== undefined) return registered;
    const resolved = this.resolveRunLimits?.(runId) ?? null;
    if (resolved === null) return this.limits;
    this.runLimits.set(runId, resolved);
    return resolved;
  }

  snapshot(runId: string): BudgetSnapshot {
    return this.runs.get(runId) ?? { runUsd: 0, runTokens: 0, perTask: {}, unknownCostCalls: [] };
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

  assertWithin(runId: string, taskId?: string): void {
    const s = this.snapshot(runId);
    const limits = this.limitsFor(runId);
    if (limits.maxRunUsd !== null && s.runUsd >= limits.maxRunUsd) {
      throw new PolishError("CONFLICT", "run USD budget exhausted", { runId, spent: s.runUsd, limit: limits.maxRunUsd, budget: "run_usd" });
    }
    if (limits.maxRunTokens !== null && s.runTokens >= limits.maxRunTokens) {
      throw new PolishError("CONFLICT", "run token budget exhausted", { runId, spent: s.runTokens, limit: limits.maxRunTokens, budget: "run_tokens" });
    }
    if (taskId !== undefined && limits.maxTaskTokens !== null && (s.perTask[taskId] ?? 0) >= limits.maxTaskTokens) {
      throw new PolishError("CONFLICT", "task token budget exhausted", { runId, taskId, spent: s.perTask[taskId], limit: limits.maxTaskTokens, budget: "task_tokens" });
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
    if (taskId !== undefined) s.perTask[taskId] = (s.perTask[taskId] ?? 0) + tokens;
    this.runs.set(runId, s);
    return s;
  }
}

export function isBudgetError(err: unknown): boolean {
  return err instanceof PolishError && err.code === "CONFLICT" && typeof err.details["budget"] === "string";
}
