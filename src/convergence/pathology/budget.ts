import type { Event } from "../../domain/event.js";
import type { PolishConfig } from "../../domain/config.js";
import type { BudgetSnapshot } from "../../broker/quota.js";
import type {
  CanonicalBudgetUsage,
  PathologyBudgetLimits,
  PathologyBudgetSnapshot,
  UnusedCliBudgetMetadata,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(event: Event): { inputTokens: number; outputTokens: number; costUsd: number | null } | null {
  const payload = asRecord(event.payload);
  const usage = asRecord(payload?.["usage"]);
  if (usage === null) return null;
  const inputTokens = usage["inputTokens"];
  const outputTokens = usage["outputTokens"];
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  const rawCost = usage["costUsd"];
  const costUsd = rawCost === null || rawCost === undefined ? null : finiteNonnegative(rawCost);
  return { inputTokens, outputTokens, costUsd };
}

function callIdOf(event: Event): string {
  const payload = asRecord(event.payload);
  const callId = payload?.["callId"];
  return typeof callId === "string" && callId.length > 0 ? callId : event.id;
}

function taskIdOf(event: Event): string | null {
  const payload = asRecord(event.payload);
  const taskId = payload?.["taskId"];
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

/** Untasked spend is attributed by role; a call whose role is absent is bucketed, never dropped. */
function roleOf(event: Event): string {
  const payload = asRecord(event.payload);
  const role = payload?.["role"];
  return typeof role === "string" && role.length > 0 ? role : "unknown";
}

/** Fold unique completed `model.call` usage once. Conflicting duplicates fail closed. */
export function foldModelCallUsage(events: readonly Event[]): CanonicalBudgetUsage {
  const byCall = new Map<string, { tokens: number; costUsd: number | null; taskId: string | null; role: string }>();
  let usageConflict = false;
  let sourceWatermark: { seq: number; eventId: string } | null = null;

  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  for (const event of ordered) {
    if (event.type !== "model.call") continue;
    const usage = usageOf(event);
    if (usage === null) continue;
    const tokens = usage.inputTokens + usage.outputTokens;
    const callId = callIdOf(event);
    const taskId = taskIdOf(event);
    const existing = byCall.get(callId);
    if (existing !== undefined) {
      if (existing.tokens !== tokens || existing.costUsd !== usage.costUsd) usageConflict = true;
      continue;
    }
    byCall.set(callId, { tokens, costUsd: usage.costUsd, taskId, role: roleOf(event) });
    sourceWatermark = { seq: event.seq, eventId: event.id };
  }

  let runTokens = 0;
  let knownRunUsd = 0;
  const unknownCostCalls: string[] = [];
  // Maps, not object literals: a task id or role of `__proto__` assigned into `{}` sets the
  // prototype instead of an own key and the tokens vanish, and `constructor` reads back as a
  // function. Both are event payload values, so neither key is unreachable by construction.
  const perTask = new Map<string, number>();
  const perRole = new Map<string, number>();
  for (const callId of [...byCall.keys()].sort()) {
    const row = byCall.get(callId);
    if (row === undefined) continue;
    runTokens += row.tokens;
    if (row.costUsd === null) unknownCostCalls.push(callId);
    else knownRunUsd += row.costUsd;
    // Disjoint by construction, so `sum(perTask) + sum(perRole) === runTokens`. Roles stay out of
    // `perTask` because `exhaustedDimensions` enforces every key there as a task budget.
    const bucket = row.taskId !== null ? perTask : perRole;
    const key = row.taskId ?? row.role;
    bucket.set(key, (bucket.get(key) ?? 0) + row.tokens);
  }

  return {
    runTokens,
    knownRunUsd,
    unknownCostCalls,
    perTask: Object.fromEntries(perTask),
    perRole: Object.fromEntries(perRole),
    sourceWatermark,
    usageConflict,
  };
}

export function budgetSnapshotFromUsage(usage: CanonicalBudgetUsage): BudgetSnapshot {
  return {
    runUsd: usage.knownRunUsd,
    runTokens: usage.runTokens,
    perTask: { ...usage.perTask },
    unknownCostCalls: [...usage.unknownCostCalls],
  };
}

export function liveBudgetLimits(config: Pick<PolishConfig, "budget">): PathologyBudgetLimits {
  return {
    maxRunTokens: config.budget.maxRunTokens,
    maxRunUsd: config.budget.maxRunUsd,
    maxTaskTokens: config.budget.maxTaskTokens,
    maxRunWallClockMinutes: config.budget.maxRunWallClockMinutes,
  };
}

export function unusedCliMetadata(input?: {
  budgetTokens?: number | null;
  budgetUsd?: number | null;
}): UnusedCliBudgetMetadata {
  const budgetTokens = input?.budgetTokens ?? null;
  const budgetUsd = input?.budgetUsd ?? null;
  // A resolved override is an applied one: the same resolution feeds the broker's tracker.
  return { budgetTokens, budgetUsd, applied: budgetTokens !== null || budgetUsd !== null };
}

export function exhaustedDimensions(usage: CanonicalBudgetUsage, limits: PathologyBudgetLimits, elapsedMs: number): string[] {
  const out: string[] = [];
  if (limits.maxRunTokens !== null && usage.runTokens >= limits.maxRunTokens) out.push("run_tokens");
  if (limits.maxRunUsd !== null && usage.knownRunUsd >= limits.maxRunUsd) out.push("run_usd");
  if (limits.maxTaskTokens !== null) {
    for (const taskId of Object.keys(usage.perTask).sort()) {
      if ((usage.perTask[taskId] ?? 0) >= limits.maxTaskTokens) out.push(`task_tokens:${taskId}`);
    }
  }
  if (limits.maxRunWallClockMinutes !== null && elapsedMs >= limits.maxRunWallClockMinutes * 60_000) {
    out.push("wall_clock");
  }
  return out;
}

export function buildPathologyBudgetSnapshot(input: {
  events: readonly Event[];
  observedAt: number;
  runCreatedAt: number;
  config: Pick<PolishConfig, "budget">;
  cliBudget?: { budgetTokens?: number | null; budgetUsd?: number | null } | undefined;
}): PathologyBudgetSnapshot {
  const usage = foldModelCallUsage(input.events);
  const limits = liveBudgetLimits(input.config);
  const elapsedMs = Math.max(0, input.observedAt - input.runCreatedAt);
  return {
    ...usage,
    elapsedMs,
    limits,
    unusedCliMetadata: unusedCliMetadata(input.cliBudget),
    exhaustedDimensions: exhaustedDimensions(usage, limits, elapsedMs),
  };
}

export function budgetIsExhausted(snapshot: Pick<PathologyBudgetSnapshot, "exhaustedDimensions" | "usageConflict">): boolean {
  return snapshot.exhaustedDimensions.length > 0;
}
