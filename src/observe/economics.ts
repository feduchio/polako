import type { Event } from "../domain/event.js";
import { isTerminal } from "../domain/fsm.js";
import type { Run, RunPhase } from "../domain/run.js";
import { RUN_PHASE_TABLE, RunPhaseSchema } from "../domain/run.js";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
}

export type ReviewFailureCause = "rate_limit" | "schema" | "bad_request" | "timeout" | "other";

export interface ReviewCounts {
  requested: number;
  completed: number;
  incomplete: number;
}

export interface ReviewYield extends ReviewCounts {
  failureCauses: Record<ReviewFailureCause, number>;
  rawFindings: number;
  validFindings: number;
  rejectedFindings: number;
  uncertainFindings: number;
  unvalidatedFindings: number;
  reviewerInputTokens: number;
  reviewerOutputTokens: number;
  completionRate: number | null;
  rawYield: number | null;
  validationYield: number | null;
  outputTokensPerRawFinding: number | null;
  outputTokensPerValidFinding: number | null;
}

export interface CandidateActivity {
  candidateCount: number;
  maxAttempt: number;
}

export interface ReviewRound extends ReviewCounts {
  byAxis: Record<string, ReviewCounts>;
}

export interface RunEconomicsReport {
  runId: string;
  outcome: {
    phase: RunPhase;
    terminal: boolean;
    taskStates: Record<string, string>;
  };
  tokens: TokenTotals;
  usd: number | null;
  failedCalls: number;
  nullUsageCalls: number;
  nullCostCalls: number;
  usageConflict: boolean;
  byRole: Record<string, TokenTotals>;
  byPurpose: Record<string, TokenTotals>;
  byTask: Record<string, TokenTotals>;
  candidatesByTask: Record<string, CandidateActivity>;
  review: {
    total: ReviewYield;
    byAxis: Record<string, ReviewYield>;
    rounds: Record<string, ReviewRound>;
  };
}

interface LogicalCall {
  representative: Event;
  usage: Usage | null;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

interface ReviewExecutionValue {
  event: Event;
  value: Record<string, unknown>;
}

interface RawFindingValue {
  event: Event;
  id: string;
  axis: string;
}

const EMPTY_CAUSES: Record<ReviewFailureCause, number> = {
  rate_limit: 0,
  schema: 0,
  bad_request: 0,
  timeout: 0,
  other: 0,
};

export function projectRunEconomics(run: Run, inputEvents: readonly Event[]): RunEconomicsReport {
  const events = [...inputEvents].sort(compareEvents);
  const calls = logicalCalls(events);
  const usageConflict = calls.some((call) => callConflict(call, events));
  const tokens = emptyTokens();
  const byRole = new Map<string, TokenTotals>();
  const byPurpose = new Map<string, TokenTotals>();
  const byTask = new Map<string, TokenTotals>();
  const reviewerUsage = new Map<string, TokenTotals>();
  let failedCalls = 0;
  let nullUsageCalls = 0;
  let nullCostCalls = 0;
  let usd = 0;

  for (const call of calls) {
    const payload = call.representative.payload;
    if (payload["ok"] === false) failedCalls++;
    if (call.usage === null) {
      nullUsageCalls++;
      continue;
    }
    if (call.usage.costUsd === null) nullCostCalls++;
    else usd += call.usage.costUsd;

    addTokens(tokens, call.usage);
    addToBreakdown(byRole, stringValue(payload["role"]) ?? "unassigned", call.usage);
    addToBreakdown(byPurpose, stringValue(payload["purpose"]) ?? "unassigned", call.usage);
    addToBreakdown(byTask, stringValue(payload["taskId"]) ?? "unassigned", call.usage);

    if (payload["role"] === "reviewer") {
      const purpose = stringValue(payload["purpose"]);
      const axis = purpose?.startsWith("review_") === true ? purpose.slice("review_".length) : "unassigned";
      addToBreakdown(reviewerUsage, axis === "" ? "unassigned" : axis, call.usage);
    }
  }

  const executions = reviewExecutions(events);
  const findings = rawFindings(events);
  const validations = latestValidations(events);
  const reviewAxes = new Set<string>([
    ...[...executions.values()].map((item) => stringValue(item.value["axis"]) ?? "unassigned"),
    ...[...findings.values()].map((item) => item.axis),
    ...reviewerUsage.keys(),
  ]);
  const byAxisEntries = [...reviewAxes].sort().map((axis) => [
    axis,
    reviewYield(axis, executions, findings, validations, reviewerUsage.get(axis) ?? emptyTokens()),
  ] as const);
  const byAxisReport = Object.fromEntries(byAxisEntries);
  const totalReview = reviewYield(null, executions, findings, validations, sumTokenMap(reviewerUsage));

  return {
    runId: run.id,
    outcome: projectOutcome(run, events),
    tokens,
    usd: nullUsageCalls > 0 || nullCostCalls > 0 ? null : usd,
    failedCalls,
    nullUsageCalls,
    nullCostCalls,
    usageConflict,
    byRole: sortedBreakdown(byRole),
    byPurpose: sortedBreakdown(byPurpose),
    byTask: sortedBreakdown(byTask),
    candidatesByTask: candidateActivity(events),
    review: {
      total: totalReview,
      byAxis: byAxisReport,
      rounds: reviewRounds(executions),
    },
  };
}

export function classifyReviewFailure(error: string | undefined): ReviewFailureCause {
  const text = error ?? "";
  if (/rate.?limit|\b429\b/i.test(text)) return "rate_limit";
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/bad request|\b400\b/i.test(text)) return "bad_request";
  if (
    /review response must contain a findings array/i.test(text) ||
    /Expected .* after array element .* JSON/i.test(text) ||
    /\binvalid_(?:type|value)\b/i.test(text)
  ) {
    return "schema";
  }
  return "other";
}

export function renderRunEconomics(report: RunEconomicsReport): string {
  const lines = [
    `Run ${report.runId}`,
    `Outcome: ${report.outcome.phase} (${report.outcome.terminal ? "terminal" : "active"})`,
    `Tokens: ${formatInt(report.tokens.totalTokens)} total = ${formatInt(report.tokens.inputTokens)} input + ${formatInt(report.tokens.outputTokens)} output`,
    report.usd === null
      ? `USD: unknown (${String(report.nullCostCalls)} null-cost, ${String(report.nullUsageCalls)} null-usage calls)`
      : `USD: $${report.usd.toFixed(6)}`,
    `Model calls: ${String(report.tokens.calls + report.nullUsageCalls)} logical, ${String(report.failedCalls)} failed`,
    "",
    "By role:",
    ...renderTokenBreakdown(report.byRole),
    "",
    "By purpose:",
    ...renderTokenBreakdown(report.byPurpose),
    "",
    "Tasks:",
    ...renderTasks(report),
    "",
    `Review: ${String(report.review.total.requested)} requested, ${String(report.review.total.completed)} completed, ${String(report.review.total.incomplete)} incomplete`,
    `Review failures: ${renderCauses(report.review.total.failureCauses)}`,
    ...Object.entries(report.review.byAxis).map(([axis, value]) =>
      `  ${axis}: ${String(value.completed)}/${String(value.requested)} complete (${formatPercent(value.completionRate)}), ${formatInt(value.reviewerInputTokens)} in + ${formatInt(value.reviewerOutputTokens)} out, ${String(value.rawFindings)} raw, ${String(value.validFindings)} valid, ${formatRatio(value.outputTokensPerValidFinding)} output tokens/valid finding`),
    `Review rounds: ${Object.entries(report.review.rounds).map(([round, value]) =>
      `${round}=${String(value.completed)}/${String(value.requested)}`).join(", ") || "none"}`,
    `Usage conflict: ${report.usageConflict ? "YES" : "no"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function logicalCalls(events: readonly Event[]): LogicalCall[] {
  const groups = new Map<string, Event[]>();
  for (const event of events) {
    if (event.type !== "model.call") continue;
    const callId = stringValue(event.payload["callId"]);
    const key = callId === null || callId === "" ? event.id : callId;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const ordered = [...group].sort(compareEvents);
    const usageEvent = ordered.find((event) => usageOf(event) !== null);
    const representative = usageEvent ?? ordered[0];
    if (representative === undefined) throw new Error("empty model.call group");
    return { representative, usage: usageOf(representative) };
  });
}

function callConflict(call: LogicalCall, events: readonly Event[]): boolean {
  const callId = stringValue(call.representative.payload["callId"]);
  if (callId === null || callId === "") return false;
  const usageEvents = events.filter(
    (event) => event.type === "model.call" &&
      stringValue(event.payload["callId"]) === callId &&
      usageOf(event) !== null,
  );
  if (usageEvents.length < 2) return false;
  const [firstEvent, ...rest] = usageEvents.sort(compareEvents);
  if (firstEvent === undefined) return false;
  const first = callSignature(firstEvent);
  return rest.some((event) => callSignature(event) !== first);
}

function callSignature(event: Event): string {
  const usage = usageOf(event);
  return JSON.stringify({
    usage,
    role: event.payload["role"] ?? null,
    purpose: event.payload["purpose"] ?? null,
    taskId: event.payload["taskId"] ?? null,
  });
}

function reviewExecutions(events: readonly Event[]): Map<string, ReviewExecutionValue> {
  const out = new Map<string, ReviewExecutionValue>();
  for (const event of events) {
    if (event.type !== "review.started" && event.type !== "review.finished") continue;
    const value = recordValue(event.payload["execution"]);
    const id = stringValue(value?.["id"]);
    if (value === null || id === null) continue;
    out.set(id, { event, value });
  }
  return out;
}

function rawFindings(events: readonly Event[]): Map<string, RawFindingValue> {
  const out = new Map<string, RawFindingValue>();
  for (const event of events) {
    if (event.type !== "finding.raised") continue;
    const finding = recordValue(event.payload["finding"]);
    const id = stringValue(finding?.["id"]);
    if (finding === null || id === null || out.has(id)) continue;
    out.set(id, { event, id, axis: stringValue(finding["axis"]) ?? "unassigned" });
  }
  return out;
}

function latestValidations(events: readonly Event[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "finding.validated") continue;
    const validation = recordValue(event.payload["validation"]);
    const findingId = stringValue(validation?.["findingId"]);
    const verdict = stringValue(validation?.["verdict"]);
    if (findingId !== null && verdict !== null) out.set(findingId, verdict);
  }
  return out;
}

function reviewYield(
  axis: string | null,
  executions: ReadonlyMap<string, ReviewExecutionValue>,
  findings: ReadonlyMap<string, RawFindingValue>,
  validations: ReadonlyMap<string, string>,
  usage: TokenTotals,
): ReviewYield {
  const scopedExecutions = [...executions.values()].filter(
    (item) => axis === null || (stringValue(item.value["axis"]) ?? "unassigned") === axis,
  );
  const scopedFindings = [...findings.values()].filter((item) => axis === null || item.axis === axis);
  const completed = scopedExecutions.filter((item) => item.value["completed"] === true).length;
  const causes = { ...EMPTY_CAUSES };
  for (const item of scopedExecutions) {
    if (item.value["completed"] === true) continue;
    causes[classifyReviewFailure(stringValue(item.value["error"]) ?? undefined)]++;
  }
  let valid = 0;
  let rejected = 0;
  let uncertain = 0;
  let unvalidated = 0;
  for (const finding of scopedFindings) {
    const verdict = validations.get(finding.id);
    if (verdict === "VALID") valid++;
    else if (verdict === "REJECTED") rejected++;
    else if (verdict === "UNCERTAIN") uncertain++;
    else unvalidated++;
  }
  const requested = scopedExecutions.length;
  const raw = scopedFindings.length;
  return {
    requested,
    completed,
    incomplete: requested - completed,
    failureCauses: causes,
    rawFindings: raw,
    validFindings: valid,
    rejectedFindings: rejected,
    uncertainFindings: uncertain,
    unvalidatedFindings: unvalidated,
    reviewerInputTokens: usage.inputTokens,
    reviewerOutputTokens: usage.outputTokens,
    completionRate: ratio(completed, requested),
    rawYield: ratio(raw, completed),
    validationYield: ratio(valid, raw),
    outputTokensPerRawFinding: ratio(usage.outputTokens, raw),
    outputTokensPerValidFinding: ratio(usage.outputTokens, valid),
  };
}

function reviewRounds(executions: ReadonlyMap<string, ReviewExecutionValue>): Record<string, ReviewRound> {
  const rounds = new Map<number, Map<string, ReviewCounts>>();
  for (const item of executions.values()) {
    const round = numberValue(item.value["roundIndex"]);
    const axis = stringValue(item.value["axis"]) ?? "unassigned";
    if (round === null) continue;
    const axes = rounds.get(round) ?? new Map<string, ReviewCounts>();
    const counts = axes.get(axis) ?? { requested: 0, completed: 0, incomplete: 0 };
    counts.requested++;
    if (item.value["completed"] === true) counts.completed++;
    else counts.incomplete++;
    axes.set(axis, counts);
    rounds.set(round, axes);
  }
  return Object.fromEntries([...rounds.entries()].sort(([a], [b]) => a - b).map(([round, axes]) => {
    const byAxis = Object.fromEntries([...axes.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const values = Object.values(byAxis);
    return [String(round), {
      requested: values.reduce((sum, value) => sum + value.requested, 0),
      completed: values.reduce((sum, value) => sum + value.completed, 0),
      incomplete: values.reduce((sum, value) => sum + value.incomplete, 0),
      byAxis,
    }];
  }));
}

function candidateActivity(events: readonly Event[]): Record<string, CandidateActivity> {
  const seen = new Set<string>();
  const byTask = new Map<string, CandidateActivity>();
  for (const event of events) {
    if (event.type !== "candidate.created") continue;
    const candidate = recordValue(event.payload["candidate"]);
    const id = stringValue(candidate?.["id"]);
    const taskId = stringValue(candidate?.["taskId"]);
    const attempt = numberValue(candidate?.["attempt"]);
    if (candidate === null || id === null || taskId === null || attempt === null || seen.has(id)) continue;
    seen.add(id);
    const current = byTask.get(taskId) ?? { candidateCount: 0, maxAttempt: 0 };
    current.candidateCount++;
    current.maxAttempt = Math.max(current.maxAttempt, attempt);
    byTask.set(taskId, current);
  }
  return Object.fromEntries([...byTask.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function projectOutcome(run: Run, events: readonly Event[]): RunEconomicsReport["outcome"] {
  let phase = run.phase;
  const taskStates = new Map<string, string>();
  for (const event of events) {
    if (event.type === "run.created" || event.type === "run.phase_changed") {
      const snapshot = recordValue(event.payload["run"]);
      const candidate = RunPhaseSchema.safeParse(snapshot?.["phase"]);
      if (candidate.success) phase = candidate.data;
    }
    if (event.type === "task.created" || event.type === "task.state_changed") {
      const task = recordValue(event.payload["task"]);
      const taskId = stringValue(task?.["id"]);
      const state = stringValue(task?.["state"]);
      if (taskId !== null && state !== null) taskStates.set(taskId, state);
    }
  }
  return {
    phase,
    terminal: isTerminal(RUN_PHASE_TABLE, phase),
    taskStates: Object.fromEntries([...taskStates.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function usageOf(event: Event): Usage | null {
  const value = recordValue(event.payload["usage"]);
  if (value === null) return null;
  const inputTokens = numberValue(value["inputTokens"]);
  const outputTokens = numberValue(value["outputTokens"]);
  if (inputTokens === null || outputTokens === null) return null;
  const rawCost = value["costUsd"];
  const costUsd = rawCost === null || rawCost === undefined ? null : numberValue(rawCost);
  return { inputTokens, outputTokens, costUsd };
}

function addToBreakdown(map: Map<string, TokenTotals>, key: string, usage: Usage): void {
  const totals = map.get(key) ?? emptyTokens();
  addTokens(totals, usage);
  map.set(key, totals);
}

function addTokens(totals: TokenTotals, usage: Pick<Usage, "inputTokens" | "outputTokens">): void {
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.totalTokens += usage.inputTokens + usage.outputTokens;
  totals.calls++;
}

function sumTokenMap(map: ReadonlyMap<string, TokenTotals>): TokenTotals {
  const totals = emptyTokens();
  for (const value of map.values()) {
    totals.inputTokens += value.inputTokens;
    totals.outputTokens += value.outputTokens;
    totals.totalTokens += value.totalTokens;
    totals.calls += value.calls;
  }
  return totals;
}

function emptyTokens(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
}

function sortedBreakdown(map: ReadonlyMap<string, TokenTotals>): Record<string, TokenTotals> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function compareEvents(a: Event, b: Event): number {
  return a.seq - b.seq || a.id.localeCompare(b.id);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function renderTokenBreakdown(values: Record<string, TokenTotals>): string[] {
  return Object.entries(values).map(([key, value]) =>
    `  ${key}: ${formatInt(value.totalTokens)} = ${formatInt(value.inputTokens)} in + ${formatInt(value.outputTokens)} out (${String(value.calls)} calls)`);
}

function renderCauses(causes: Record<ReviewFailureCause, number>): string {
  return (Object.entries(causes) as [ReviewFailureCause, number][])
    .map(([cause, count]) => `${cause}=${String(count)}`)
    .join(", ");
}

function renderTasks(report: RunEconomicsReport): string[] {
  const taskIds = new Set([
    ...Object.keys(report.byTask),
    ...Object.keys(report.outcome.taskStates),
    ...Object.keys(report.candidatesByTask),
  ]);
  return [...taskIds].sort().map((taskId) => {
    const tokens = report.byTask[taskId] ?? emptyTokens();
    const candidates = report.candidatesByTask[taskId];
    const state = report.outcome.taskStates[taskId] ?? "unknown";
    const candidateText = candidates === undefined
      ? "0 candidates"
      : `${String(candidates.candidateCount)} candidates, max attempt ${String(candidates.maxAttempt)}`;
    return `  ${taskId}: ${state}, ${formatInt(tokens.totalTokens)} tokens, ${candidateText}`;
  });
}

function formatRatio(value: number | null): string {
  return value === null ? "undefined" : value.toFixed(2);
}

function formatPercent(value: number | null): string {
  return value === null ? "undefined" : `${(value * 100).toFixed(1)}%`;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
