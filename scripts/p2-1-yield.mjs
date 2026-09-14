#!/usr/bin/env node
// P2.1 — post-validation yield. Read-only measurement over a Polish store.
// Contract: docs/ledger/P2.1.md. Run: node scripts/p2-1-yield.mjs [--store PATH] [--cutoff MS] [--json]
//
// The store is opened read-only and never through src/store/db.ts openDb, which migrates
// and would write. Nothing here is production code; it is an instrument whose output is a report.
//
// One population decides everything. MC1 classifies a review EXECUTION by the ts of the
// review.finished event that recorded it; findings, validations, tasks and reviewer tokens then
// inherit the bucket of the execution they belong to. Nothing is classified by its own timestamp,
// because a finding raised after the cut-off from a pre-cut-off execution was still parsed by the
// broken parser, and a call issued before the cut-off for an eligible execution is still its call.

import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

/** finding 41's parser fix, commit 3f23ede, author timestamp 2026-09-12T18:43:57Z. */
const DEFAULT_CUTOFF_MS = 1789238637000;
const CUTOFF_COMMIT = "3f23ede";

/** Values recorded before this instrument existed; MC5 requires reproducing them. */
const EXPECTED = {
  reviewerCalls: 209,
  reviewerNullUsageCalls: 83,
  reviewerTokens: 834635,
  completedReviewExecutions: 18,
};

/** The two runs whose rounds form the g1 baseline (docs/ledger/g1-baseline.md). */
const BASELINE_RUNS = ["run_01m1my3pdwwqxr1pe45z91", "run_01m1p013kghsprxj7atb6w"];

/** Default axes, for stable row order only. Any other axis in the data is reported too. */
const DEFAULT_AXES = ["correctness", "regression", "adversarial"];

/** An execution is in exactly one of these. Only `eligible` may carry a yield number. */
const BUCKETS = ["eligible", "ineligible", "unfinished", "unattributed"];

function parseArgs(argv) {
  const out = { store: join(homedir(), ".polish", "polish.db"), cutoff: DEFAULT_CUTOFF_MS, json: false, selfcheck: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--selfcheck") out.selfcheck = true;
    else if (arg === "--store") out.store = argv[++i];
    else if (arg === "--cutoff") out.cutoff = Number(argv[++i]);
    else if (arg.startsWith("--store=")) out.store = arg.slice("--store=".length);
    else if (arg.startsWith("--cutoff=")) out.cutoff = Number(arg.slice("--cutoff=".length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.cutoff)) throw new Error(`--cutoff must be epoch milliseconds, got ${out.cutoff}`);
  return out;
}

/**
 * Every dictionary keyed by data — axis, purpose, status, error kind, phase — has a null
 * prototype. With a plain object, an axis literally named `constructor` reads back Object's
 * constructor instead of undefined and its counts vanish, and `__proto__` never becomes an own
 * property at all. The keys here come from event payloads, so they are not ours to trust.
 */
function bag() {
  return Object.create(null);
}

function bump(dictionary, key, amount = 1) {
  dictionary[key] = (dictionary[key] ?? 0) + amount;
}

function emptyAxisRow() {
  return {
    executions: 0,
    completedExecutions: 0,
    rawFindingItems: 0,
    findingsRaised: 0,
    survivedTriage: 0,
    survivedReproduction: 0,
    rejectedByReproduction: 0,
    uncertain: 0,
    tasksSpawned: 0,
    reviewerCalls: 0,
    nullUsageCalls: 0,
    malformedUsageCalls: 0,
    reviewerTokens: 0,
  };
}

function emptyPopulation() {
  return { axes: bag(), executionIds: new Set(), runIds: new Set(), findingStatuses: bag() };
}

function rowFor(population, axis) {
  population.axes[axis] ??= emptyAxisRow();
  return population.axes[axis];
}

/**
 * Tokens for one call. `usage: null` is a failed call and contributes 0 by docs/PLAN.md §1's rule.
 * A usage object whose fields are not finite numbers is malformed, contributes 0, and is counted —
 * never added, because `"oops" + 2` is `"oops2"` and one such row turns every total into a string.
 */
function tokensOf(usage) {
  if (usage === null || usage === undefined) return { tokens: 0, nullUsage: true, malformed: false };
  const ok = (value) => value === undefined || value === null || (typeof value === "number" && Number.isFinite(value));
  if (!ok(usage.inputTokens) || !ok(usage.outputTokens)) return { tokens: 0, nullUsage: false, malformed: true };
  return { tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), nullUsage: false, malformed: false };
}

function read(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const all = (sql) => db.prepare(sql).all();
    return {
      executions: all("SELECT id, run_id, axis, completed, json FROM review_executions").map((r) => ({
        id: r.id,
        runId: r.run_id,
        axis: r.axis,
        completed: r.completed === 1,
        value: JSON.parse(r.json),
      })),
      findings: all("SELECT id, run_id, status, json FROM findings").map((r) => ({
        id: r.id,
        runId: r.run_id,
        status: r.status,
        value: JSON.parse(r.json),
      })),
      validations: all("SELECT id, finding_id, verdict, json FROM finding_validations").map((r) => ({
        id: r.id,
        findingId: r.finding_id,
        verdict: r.verdict,
      })),
      tasks: all("SELECT id, run_id, state, json FROM tasks").map((r) => ({
        id: r.id,
        runId: r.run_id,
        state: r.state,
        value: JSON.parse(r.json),
      })),
      events: all(
        "SELECT id, run_id, seq, ts, type, json FROM events WHERE type IN ('review.started','review.finished','model.call','finding.raised','run.phase_changed','model.observation.recorded') ORDER BY run_id, seq",
      ).map((r) => ({ id: r.id, runId: r.run_id, seq: r.seq, ts: r.ts, type: r.type, value: JSON.parse(r.json) })),
      causes: all("SELECT event_id, cause_id FROM event_causes"),
      runs: all("SELECT id, phase, control, updated_at FROM runs"),
      runSpans: all("SELECT run_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS events FROM events GROUP BY run_id").map(
        (r) => ({ runId: r.run_id, firstTs: r.first_ts, lastTs: r.last_ts, events: r.events }),
      ),
      reviewedRuns: new Set(all("SELECT DISTINCT run_id FROM events WHERE type = 'review.started'").map((r) => r.run_id)),
    };
  } finally {
    db.close();
  }
}

function measure(data, cutoff) {
  // 1. Execution buckets. MC1: the deciding timestamp is the review.finished event's. An execution
  // with no review.finished was never parsed, so it is `unfinished` and can never be eligible —
  // falling back to review.started would admit an execution whose response does not exist.
  // The projection row is the identity, not the event payload. A review event is only allowed to
  // speak for an execution when it names a row that exists and belongs to the same run; the axis
  // then comes from the row. Otherwise the event and the row could disagree and the disagreement
  // would be invisible. Mismatches are counted and reported, never quietly followed.
  const executionById = new Map(data.executions.map((execution) => [execution.id, execution]));
  const inconsistencies = { reviewEventUnknownExecution: 0, reviewEventRunMismatch: 0, reviewEventAxisMismatch: 0, ambiguousFindingCause: 0 };

  // Resolved once per event, not once per pass, or the inconsistency counters would report the
  // same malformed event as many times as the code happens to look at it.
  const rowOfReviewEvent = new Map();
  for (const event of data.events) {
    if (event.type !== "review.started" && event.type !== "review.finished") continue;
    const payload = event.value.payload?.execution;
    if (payload === undefined || typeof payload.id !== "string") {
      rowOfReviewEvent.set(event.id, null);
      continue;
    }
    const row = executionById.get(payload.id);
    if (row === undefined) {
      inconsistencies.reviewEventUnknownExecution += 1;
      rowOfReviewEvent.set(event.id, null);
      continue;
    }
    if (row.runId !== event.runId) {
      inconsistencies.reviewEventRunMismatch += 1;
      rowOfReviewEvent.set(event.id, null);
      continue;
    }
    if (payload.axis !== row.axis) inconsistencies.reviewEventAxisMismatch += 1;
    rowOfReviewEvent.set(event.id, row);
  }

  const finishedTs = new Map();
  const startedTs = new Map();
  for (const event of data.events) {
    const map = event.type === "review.finished" ? finishedTs : event.type === "review.started" ? startedTs : null;
    if (map === null) continue;
    const row = rowOfReviewEvent.get(event.id) ?? null;
    if (row === null) continue;
    const prior = map.get(row.id);
    if (prior === undefined || event.ts < prior) map.set(row.id, event.ts);
  }

  // Duplicate review.finished events resolve to the EARLIEST, above: the parse happened at the
  // first finish, and taking the earliest can only move an execution out of `eligible`, never into
  // it. Recorded as a decision because the contract does not specify duplicates.
  const bucketOfExecution = new Map();
  for (const execution of data.executions) {
    const finished = finishedTs.get(execution.id);
    const bucket =
      finished !== undefined
        ? finished >= cutoff
          ? "eligible"
          : "ineligible"
        : startedTs.has(execution.id)
          ? "unfinished"
          : "unattributed";
    bucketOfExecution.set(execution.id, bucket);
  }

  const populations = {};
  for (const bucket of BUCKETS) populations[bucket] = emptyPopulation();

  for (const execution of data.executions) {
    const population = populations[bucketOfExecution.get(execution.id)];
    population.executionIds.add(execution.id);
    population.runIds.add(execution.runId);
    const row = rowFor(population, execution.axis);
    row.executions += 1;
    if (execution.completed) row.completedExecutions += 1;
    row.rawFindingItems += Array.isArray(execution.value.findings) ? execution.value.findings.length : 0;
  }

  // 2. Findings follow their execution, joined exactly rather than by time: raiseFinding appends
  // finding.raised with causedBy = the review execution's id
  // (src/engine/reviewDrivers.ts:866-867, :1240-1251), which lands in event_causes.
  const causesByEvent = new Map();
  for (const cause of data.causes) {
    const list = causesByEvent.get(cause.event_id) ?? [];
    list.push(cause.cause_id);
    causesByEvent.set(cause.event_id, list);
  }
  const executionOfFinding = new Map();
  for (const event of data.events) {
    if (event.type !== "finding.raised") continue;
    const finding = event.value.payload?.finding;
    if (finding === undefined || typeof finding.id !== "string") continue;
    if (executionOfFinding.has(finding.id)) continue;
    // Exactly one execution cause, or none. raiseFinding passes exactly one
    // (src/engine/reviewDrivers.ts:866-867), so two is a store we do not understand; picking the
    // first would silently choose a bucket.
    const executionCauses = [...new Set(causesByEvent.get(event.id) ?? [])].filter((cause) => bucketOfExecution.has(cause));
    if (executionCauses.length === 1) executionOfFinding.set(finding.id, executionCauses[0]);
    else if (executionCauses.length > 1) inconsistencies.ambiguousFindingCause += 1;
  }

  const validationsByFinding = new Map();
  for (const validation of data.validations) {
    const list = validationsByFinding.get(validation.findingId) ?? [];
    list.push(validation);
    validationsByFinding.set(validation.findingId, list);
  }

  const tasksByFinding = new Map();
  for (const task of data.tasks) {
    const findingId = task.value.origin?.findingId;
    if (typeof findingId !== "string") continue;
    const list = tasksByFinding.get(findingId) ?? [];
    list.push(task);
    tasksByFinding.set(findingId, list);
  }

  // Triage survival. A validation row exists only for disposition "validate"
  // (src/findings/validator.ts:95-98). RAW means triage has not run at all, so RAW is not a
  // survivor; DUPLICATE and NOTED are the dispositions that stop there.
  const NOT_TRIAGE_SURVIVOR = ["RAW", "DUPLICATE", "NOTED"];
  for (const finding of data.findings) {
    const executionId = executionOfFinding.get(finding.id);
    const bucket = executionId === undefined ? "unattributed" : bucketOfExecution.get(executionId);
    const population = populations[bucket];
    population.runIds.add(finding.runId);
    bump(population.findingStatuses, finding.status);
    const row = rowFor(population, typeof finding.value.axis === "string" ? finding.value.axis : "unknown");
    row.findingsRaised += 1;
    const validations = validationsByFinding.get(finding.id) ?? [];
    if (validations.length > 0 || !NOT_TRIAGE_SURVIVOR.includes(finding.status)) row.survivedTriage += 1;
    if (validations.some((v) => v.verdict === "VALID")) row.survivedReproduction += 1;
    if (validations.some((v) => v.verdict === "REJECTED")) row.rejectedByReproduction += 1;
    if (validations.some((v) => v.verdict === "UNCERTAIN")) row.uncertain += 1;
    row.tasksSpawned += (tasksByFinding.get(finding.id) ?? []).length;
  }

  // 3. Reviewer tokens follow their execution too, attributed by docs/PLAN.md §1's rule: scan
  // events in (run_id, seq) order and attribute each reviewer model.call to the execution opened by
  // the most recent preceding review.started for that (runId, axis). Null usage contributes 0
  // tokens and is counted separately. A call with no preceding review.started is `unattributed`.
  const whole = { reviewerCalls: 0, nullUsageCalls: 0, malformedUsageCalls: 0, tokens: 0, byPurpose: bag() };
  const baselineRunsOnly = { reviewerCalls: 0, nullUsageCalls: 0, tokens: 0 };
  const openExecution = new Map();
  for (const event of data.events) {
    if (event.type === "review.started") {
      const row = rowOfReviewEvent.get(event.id) ?? null;
      if (row !== null) openExecution.set(`${row.runId}\u0000${row.axis}`, row.id);
      continue;
    }
    if (event.type !== "model.call") continue;
    const payload = event.value.payload ?? {};
    if (payload.role !== "reviewer") continue;
    // MC2 attributes by `purpose == "review_<axis>"`. A purpose without that prefix names no axis,
    // so it cannot be attributed to one: it is counted under its raw purpose in `unattributed`
    // rather than silently becoming an axis of the same name.
    const purpose = typeof payload.purpose === "string" ? payload.purpose : "unknown";
    const attributable = purpose.startsWith("review_") && purpose.length > "review_".length;
    const axis = attributable ? purpose.slice("review_".length) : `purpose:${purpose}`;
    const { tokens, nullUsage, malformed } = tokensOf(payload.usage);
    whole.reviewerCalls += 1;
    whole.tokens += tokens;
    if (nullUsage) whole.nullUsageCalls += 1;
    if (malformed) whole.malformedUsageCalls += 1;
    bump(whole.byPurpose, purpose, tokens);
    if (BASELINE_RUNS.includes(event.runId)) {
      baselineRunsOnly.reviewerCalls += 1;
      baselineRunsOnly.tokens += tokens;
      if (nullUsage) baselineRunsOnly.nullUsageCalls += 1;
    }
    const executionId = attributable ? openExecution.get(`${event.runId}\u0000${axis}`) : undefined;
    const bucket = executionId === undefined ? "unattributed" : bucketOfExecution.get(executionId) ?? "unattributed";
    const row = rowFor(populations[bucket], axis);
    row.reviewerCalls += 1;
    row.reviewerTokens += tokens;
    if (nullUsage) row.nullUsageCalls += 1;
    if (malformed) row.malformedUsageCalls += 1;
  }

  // 4. Run accounting. An empty eligible set has two very different explanations — nothing ran, or
  // things ran and never reached REVIEWING — and the report must not be able to conflate them.
  const spanByRun = new Map(data.runSpans.map((span) => [span.runId, span]));
  const phasesByRun = new Map();
  const failuresByRun = new Map();
  const phaseNow = new Map();
  for (const event of data.events) {
    if (event.type === "run.phase_changed") {
      const phase = event.value.payload?.run?.phase;
      if (typeof phase !== "string") continue;
      phaseNow.set(event.runId, phase);
      const set = phasesByRun.get(event.runId) ?? new Set();
      set.add(phase);
      phasesByRun.set(event.runId, set);
    } else if (event.type === "model.observation.recorded") {
      const outcome = event.value.payload?.observation?.outcome;
      if (outcome === undefined || outcome.ok !== false) continue;
      const kind = typeof outcome.errorKind === "string" ? outcome.errorKind : "unknown";
      const phase = phaseNow.get(event.runId) ?? "unknown";
      const counts = failuresByRun.get(event.runId) ?? { byErrorKind: bag(), byPhase: bag() };
      bump(counts.byErrorKind, kind);
      bump(counts.byPhase, phase);
      failuresByRun.set(event.runId, counts);
    }
  }
  const runAccounting = data.runs.map((run) => {
    const span = spanByRun.get(run.id);
    const failures = failuresByRun.get(run.id) ?? { byErrorKind: bag(), byPhase: bag() };
    return {
      runId: run.id,
      phase: run.phase,
      control: run.control,
      firstEventTs: span?.firstTs ?? null,
      lastEventTs: span?.lastTs ?? null,
      startedAfterCutoff: span !== undefined && span.firstTs >= cutoff,
      reachedReviewing: data.reviewedRuns.has(run.id),
      phasesReached: [...(phasesByRun.get(run.id) ?? [])],
      failedCalls: failures,
    };
  });
  const postCutoff = runAccounting.filter((run) => run.startedAfterCutoff);
  const postCutoffFailures = { total: 0, byErrorKind: bag(), byPhase: bag() };
  for (const run of postCutoff) {
    for (const [kind, count] of Object.entries(run.failedCalls.byErrorKind)) {
      bump(postCutoffFailures.byErrorKind, kind, count);
      postCutoffFailures.total += count;
    }
    for (const [phase, count] of Object.entries(run.failedCalls.byPhase)) {
      bump(postCutoffFailures.byPhase, phase, count);
    }
  }

  const report = {
    cutoff,
    cutoffCommit: CUTOFF_COMMIT,
    cutoffIso: new Date(cutoff).toISOString(),
    populations: bag(),
    inconsistencies: { ...inconsistencies, malformedUsageCalls: whole.malformedUsageCalls },
    reproduction: {
      reviewerCalls: { expected: EXPECTED.reviewerCalls, measured: whole.reviewerCalls },
      reviewerNullUsageCalls: { expected: EXPECTED.reviewerNullUsageCalls, measured: whole.nullUsageCalls },
      reviewerTokens: { expected: EXPECTED.reviewerTokens, measured: whole.tokens },
      completedReviewExecutions: {
        expected: EXPECTED.completedReviewExecutions,
        measured: data.executions.filter((e) => e.completed).length,
      },
      baselineRunsOnly,
      reviewerTokensByPurpose: whole.byPurpose,
    },
    store: {
      runs: data.runs.length,
      reviewExecutions: data.executions.length,
      findings: data.findings.length,
      validations: data.validations.length,
      tasks: data.tasks.length,
    },
    runs: {
      total: runAccounting.length,
      startedAfterCutoff: postCutoff.length,
      startedAfterCutoffAndReviewed: postCutoff.filter((run) => run.reachedReviewing).length,
      postCutoffPhasesReached: [...new Set(postCutoff.flatMap((run) => run.phasesReached))],
      postCutoffFailedCalls: postCutoffFailures,
      detail: runAccounting,
    },
  };
  for (const bucket of BUCKETS) {
    const population = populations[bucket];
    report.populations[bucket] = {
      executions: population.executionIds.size,
      runs: [...population.runIds].sort(),
      axes: population.axes,
      findingStatuses: population.findingStatuses,
    };
  }
  return report;
}

function totals(population) {
  let findingsRaised = 0;
  let survivedTriage = 0;
  let survivedReproduction = 0;
  for (const row of Object.values(population.axes)) {
    findingsRaised += row.findingsRaised;
    survivedTriage += row.survivedTriage;
    survivedReproduction += row.survivedReproduction;
  }
  return { findingsRaised, survivedTriage, survivedReproduction };
}

/**
 * MC3's verdict is the one for an empty eligible SET, and MC1 defines that set as executions. An
 * eligible execution that completed with an empty findings array is not an empty set: it is a
 * measured zero, which is yield data. Reporting it as "empty" would be the same error MC3 forbids
 * in the other direction — a yield of zero dressed up as an absence of rows.
 */
function verdict(report) {
  const eligible = report.populations.eligible;
  const sums = totals(eligible);
  if (eligible.executions === 0) {
    return {
      verdict: "inconclusive — no post-plumbing production findings",
      eligibleExecutions: 0,
      eligibleFindings: sums.findingsRaised,
      eligibleTableReported: false,
    };
  }
  return {
    verdict: "measured",
    eligibleExecutions: eligible.executions,
    eligibleFindings: sums.findingsRaised,
    eligibleTableReported: true,
  };
}

function mismatches(report) {
  const out = [];
  for (const [name, pair] of Object.entries(report.reproduction)) {
    if (typeof pair !== "object" || pair === null || !("expected" in pair)) continue;
    if (pair.expected !== pair.measured) out.push({ name, ...pair });
  }
  return out;
}

function axisOrder(axes) {
  const present = Object.keys(axes);
  return [...DEFAULT_AXES.filter((axis) => present.includes(axis)), ...present.filter((axis) => !DEFAULT_AXES.includes(axis)).sort()];
}

function renderAxisTable(axes) {
  const order = axisOrder(axes);
  if (order.length === 0) return "(no rows)";
  const lines = [
    "| axis | execs | completed | raw items | findings | triage | reproduced | rejected | uncertain | tasks | calls | null usage | bad usage | tokens |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const axis of order) {
    const r = axes[axis];
    lines.push(
      `| ${axis} | ${r.executions} | ${r.completedExecutions} | ${r.rawFindingItems} | ${r.findingsRaised} | ${r.survivedTriage} | ${r.survivedReproduction} | ${r.rejectedByReproduction} | ${r.uncertain} | ${r.tasksSpawned} | ${r.reviewerCalls} | ${r.nullUsageCalls} | ${r.malformedUsageCalls} | ${r.reviewerTokens} |`,
    );
  }
  return lines.join("\n");
}

function render(report) {
  const v = verdict(report);
  const bad = mismatches(report);
  const out = [];
  out.push("P2.1 post-validation yield");
  out.push(`cut-off: ${report.cutoffCommit} @ ${report.cutoff} (${report.cutoffIso})`);
  out.push(
    `store: ${report.store.runs} runs, ${report.store.reviewExecutions} review executions, ${report.store.findings} findings, ${report.store.validations} validations, ${report.store.tasks} tasks`,
  );
  out.push("");
  out.push(`VERDICT: ${v.verdict}`);
  out.push(`eligible review executions: ${v.eligibleExecutions}; eligible findings raised: ${v.eligibleFindings}`);
  out.push(
    `runs: ${report.runs.total} total, ${report.runs.startedAfterCutoff} started after the cut-off, ${report.runs.startedAfterCutoffAndReviewed} of those reached REVIEWING`,
  );
  out.push(`phases reached by post-cut-off runs: ${report.runs.postCutoffPhasesReached.join(", ") || "none"}`);
  out.push(
    `failed provider calls in post-cut-off runs: ${report.runs.postCutoffFailedCalls.total} — by error kind ${JSON.stringify(report.runs.postCutoffFailedCalls.byErrorKind)}, by phase at the time of the call ${JSON.stringify(report.runs.postCutoffFailedCalls.byPhase)}`,
  );
  out.push("");
  if (v.eligibleTableReported) {
    out.push(`Eligible population, runs: ${report.populations.eligible.runs.join(", ") || "none"}`);
    out.push(renderAxisTable(report.populations.eligible.axes));
    out.push(`eligible finding statuses: ${JSON.stringify(report.populations.eligible.findingStatuses)}`);
  } else {
    // AC2: when the MC3 verdict is what is being reported, the eligible per-axis table is not
    // printed beside it. A table of zeros is a yield of zero wearing a different hat.
    out.push(`Eligible population: empty, so no per-axis yield table is reported (AC2). Executions: ${v.eligibleExecutions}.`);
  }
  out.push("");
  for (const bucket of ["ineligible", "unfinished", "unattributed"]) {
    const population = report.populations[bucket];
    const label = {
      ineligible: "Ineligible — review.finished before the cut-off; discarded parser output",
      unfinished: "Unfinished — review.started with no review.finished; never parsed at all",
      unattributed:
        "Unattributed — could not be classified: an execution row with no events, a finding with no execution cause, or a call with no open execution or no review_ purpose. Never eligible",
    }[bucket];
    out.push(`${label}. Executions: ${population.executions}. Runs: ${population.runs.join(", ") || "none"}`);
    out.push(renderAxisTable(population.axes));
    out.push(`finding statuses: ${JSON.stringify(population.findingStatuses)}`);
    out.push("");
  }
  const badStore = Object.entries(report.inconsistencies).filter(([, count]) => count > 0);
  out.push(
    badStore.length === 0
      ? "Store consistency: no unknown or mismatched review events, no ambiguous finding cause, no malformed usage."
      : `STORE INCONSISTENCIES (counted, never followed): ${JSON.stringify(report.inconsistencies)}`,
  );
  out.push("");
  out.push("MC5 reproduction of figures recorded before this instrument existed:");
  out.push("| figure | expected | measured | agrees |");
  out.push("|---|---|---|---|");
  for (const [name, pair] of Object.entries(report.reproduction)) {
    if (typeof pair !== "object" || pair === null || !("expected" in pair)) continue;
    out.push(`| ${name} | ${pair.expected} | ${pair.measured} | ${pair.expected === pair.measured ? "yes" : "NO"} |`);
  }
  out.push(`baseline runs only: ${JSON.stringify(report.reproduction.baselineRunsOnly)}`);
  out.push(`reviewer tokens by purpose: ${JSON.stringify(report.reproduction.reviewerTokensByPurpose)}`);
  if (bad.length > 0) out.push(`MISMATCHES: ${JSON.stringify(bad)}`);
  return out.join("\n");
}

// --selfcheck. The production store currently holds no eligible row, so the eligible half of the
// classification above is otherwise unexercised: every number in the real report comes from the
// ineligible population. This builds a synthetic store on the real schema where each bucket is
// populated on purpose, and asserts the classification. It is the check on the code paths the real
// store cannot reach, and it is designed so that the four ways of getting this wrong all fail it:
// falling back to review.started, classifying a finding or a call by its own timestamp instead of
// its execution's, counting a RAW finding as triaged, and summing the verdict over three fixed axes.

const SELFCHECK_SCHEMA = `
CREATE TABLE events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, actor_kind TEXT NOT NULL, json TEXT NOT NULL, UNIQUE (run_id, seq));
CREATE TABLE event_causes (event_id TEXT NOT NULL, cause_id TEXT NOT NULL, PRIMARY KEY (event_id, cause_id));
CREATE TABLE runs (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, phase TEXT NOT NULL, control TEXT NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, kind TEXT NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE findings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, checkpoint_hash TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE finding_validations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, finding_id TEXT NOT NULL, verdict TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE review_executions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, checkpoint_hash TEXT NOT NULL, round_index INTEGER NOT NULL, axis TEXT NOT NULL, completed INTEGER NOT NULL, json TEXT NOT NULL);
`;

function buildSelfcheckStore(path) {
  const db = new DatabaseSync(path);
  db.exec(SELFCHECK_SCHEMA);
  const RUN = "run_selfcheck";
  const CUTOFF = 1000;
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(RUN, "msn_x", "REVIEWING", "RUNNING", 2000, "{}");

  let seq = 0;
  const event = (ts, type, payload, causes = []) => {
    seq += 1;
    const id = `evt_${seq}`;
    db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?)").run(
      id,
      RUN,
      seq,
      ts,
      type,
      "system",
      JSON.stringify({ id, runId: RUN, seq, ts, type, payload, causedBy: causes, actor: { kind: "system" }, artifacts: [] }),
    );
    for (const cause of causes) db.prepare("INSERT INTO event_causes VALUES (?,?)").run(id, cause);
    return id;
  };
  const execution = (id, axis, startedAt, finishedAt, completed, findings) => {
    const value = { id, runId: RUN, checkpointHash: "c0ffee", roundIndex: 1, axis, requestedModel: {}, completed, findings, startedAt, finishedAt };
    db.prepare("INSERT INTO review_executions VALUES (?,?,?,?,?,?,?)").run(id, RUN, "c0ffee", 1, axis, completed ? 1 : 0, JSON.stringify(value));
    return value;
  };
  const finding = (id, axis, status) => {
    const value = { id, runId: RUN, checkpointHash: "c0ffee", axis, status, fingerprint: id, blocking: true };
    db.prepare("INSERT INTO findings VALUES (?,?,?,?,?,?)").run(id, RUN, "c0ffee", status, id, JSON.stringify(value));
    return value;
  };
  const validation = (id, findingId, verdict) => {
    db.prepare("INSERT INTO finding_validations VALUES (?,?,?,?,?)").run(id, RUN, findingId, verdict, JSON.stringify({ id, findingId, runId: RUN, verdict }));
  };
  const call = (ts, purpose, usage) =>
    event(ts, "model.call", { callId: `call_${seq + 1}`, role: "reviewer", purpose, usage });

  // Ineligible: finished before the cut-off. Its call is before the cut-off and its finding is
  // raised well after it — the finding must still be ineligible, because the parse was.
  const inelig = execution("rex_inelig", "regression", 800, 950, true, []);
  event(800, "review.started", { execution: inelig });
  call(900, "review_regression", { inputTokens: 15, outputTokens: 5 });
  event(950, "review.finished", { execution: inelig });

  // Eligible: finished after the cut-off. Its call is before the cut-off and must still be eligible.
  const elig = execution("rex_elig", "correctness", 900, 1500, true, [{}, {}]);
  event(900, "review.started", { execution: elig });
  call(950, "review_correctness", { inputTokens: 6, outputTokens: 4 });
  event(1500, "review.finished", { execution: elig });

  // Eligible on an axis outside the three defaults, to catch a verdict summed over a fixed list.
  const arch = execution("rex_arch", "architecture", 900, 1500, true, [{}]);
  event(900, "review.started", { execution: arch });
  event(1500, "review.finished", { execution: arch });

  // Unfinished: started after the cut-off, never finished. Must never be eligible.
  const unfin = execution("rex_unfin", "adversarial", 1600, null, false, []);
  event(1600, "review.started", { execution: unfin });
  call(1700, "review_adversarial", null);

  // An execution row with no events at all is not "unfinished" — there is no review.started to say
  // it began. It cannot be classified, so it is unattributed.
  execution("rex_eventless", "performance", 1600, null, false, []);

  // Two review.finished events for one execution, one either side of the cut-off. The earliest
  // wins, so this execution is ineligible.
  const dup = execution("rex_dup", "security", 900, 950, true, []);
  event(900, "review.started", { execution: dup });
  event(950, "review.finished", { execution: dup });
  event(1900, "review.finished", { execution: dup });

  // A reviewer call whose purpose names no axis, issued while an eligible correctness execution is
  // open. It must not land in that execution's tokens.
  call(1500, "correctness", { inputTokens: 3, outputTokens: 2 });

  // An execution whose review events claim a different axis than its row. The row decides, and the
  // disagreement is counted rather than followed.
  const liar = execution("rex_liar", "coupling", 900, 1500, true, []);
  event(900, "review.started", { execution: { ...liar, axis: "performance" } });
  event(1500, "review.finished", { execution: { ...liar, axis: "performance" } });
  call(1500, "review_performance", { inputTokens: 100, outputTokens: 100 });

  // Malformed usage. One string field would turn every total into a concatenated string.
  call(1500, "review_coupling", { inputTokens: "oops", outputTokens: 2 });

  // Axis names that collide with Object.prototype. In a plain-object dictionary these vanish.
  const proto = execution("rex_proto", "__proto__", 900, 1500, true, []);
  event(900, "review.started", { execution: proto });
  event(1500, "review.finished", { execution: proto });
  call(1500, "review___proto__", { inputTokens: 1, outputTokens: 1 });
  const ctor = execution("rex_ctor", "constructor", 900, 1500, true, []);
  event(900, "review.started", { execution: ctor });
  event(1500, "review.finished", { execution: ctor });
  call(1500, "review_constructor", { inputTokens: 2, outputTokens: 2 });

  // A review event naming an execution row that does not exist, and one naming a row from another
  // run. Neither may open or close anything.
  event(1500, "review.started", { execution: { id: "rex_ghost", axis: "correctness" } });
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run("run_other", "msn_x", "REVIEWING", "RUNNING", 2000, "{}");
  const foreign = { id: "rex_foreign", runId: "run_other", checkpointHash: "c0ffee", roundIndex: 1, axis: "correctness", completed: true, findings: [], startedAt: 900, finishedAt: 1500 };
  db.prepare("INSERT INTO review_executions VALUES (?,?,?,?,?,?,?)").run("rex_foreign", "run_other", "c0ffee", 1, "correctness", 1, JSON.stringify(foreign));
  event(1500, "review.finished", { execution: foreign });

  // A finding citing two executions in different buckets. Choosing either would be arbitrary.
  finding("fnd_ambiguous", "correctness", "VALID");
  validation("fval_4", "fnd_ambiguous", "VALID");
  event(1500, "finding.raised", { finding: { id: "fnd_ambiguous" } }, ["rex_elig", "rex_inelig"]);

  // A finding reproduction REJECTED. It survived triage and did not survive reproduction; a rule
  // that counted any validation row as reproduction survival would say otherwise.
  finding("fnd_rejected", "correctness", "REJECTED");
  validation("fval_5", "fnd_rejected", "REJECTED");
  event(1500, "finding.raised", { finding: { id: "fnd_rejected" } }, ["rex_elig"]);

  finding("fnd_elig_valid", "correctness", "VALID");
  validation("fval_1", "fnd_elig_valid", "VALID");
  event(1500, "finding.raised", { finding: { id: "fnd_elig_valid" } }, ["rex_elig"]);

  finding("fnd_elig_raw", "correctness", "RAW");
  event(1500, "finding.raised", { finding: { id: "fnd_elig_raw" } }, ["rex_elig"]);

  finding("fnd_inelig_late", "regression", "VALID");
  validation("fval_2", "fnd_inelig_late", "VALID");
  event(2000, "finding.raised", { finding: { id: "fnd_inelig_late" } }, ["rex_inelig"]);

  finding("fnd_arch", "architecture", "VALID");
  validation("fval_3", "fnd_arch", "VALID");
  event(1500, "finding.raised", { finding: { id: "fnd_arch" } }, ["rex_arch"]);

  finding("fnd_orphan", "correctness", "VALID");
  event(2000, "finding.raised", { finding: { id: "fnd_orphan" } }, []);

  call(1700, "review_ghost", { inputTokens: 4, outputTokens: 3 });

  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run(
    "task_1",
    RUN,
    "READY",
    "bugfix",
    1500,
    JSON.stringify({ id: "task_1", runId: RUN, origin: { kind: "valid_finding", findingId: "fnd_elig_valid" } }),
  );
  db.close();
  return CUTOFF;
}

/**
 * The shape the store will actually have first: one post-cut-off execution that completed and
 * parsed to an empty findings array — what `finishExecution` writes for a reviewer that found
 * nothing, and what `skipExecution` writes for P1.1's skip. That is a measured zero, not an empty
 * eligible set, and it must not be reported through MC3.
 */
function buildEmptyParseStore(path) {
  const db = new DatabaseSync(path);
  db.exec(SELFCHECK_SCHEMA);
  const RUN = "run_empty_parse";
  const CUTOFF = 1000;
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)").run(RUN, "msn_x", "REVIEWING", "RUNNING", 2000, "{}");
  const value = { id: "rex_empty", runId: RUN, checkpointHash: "c0ffee", roundIndex: 1, axis: "correctness", requestedModel: {}, completed: true, findings: [], startedAt: 1400, finishedAt: 1500 };
  db.prepare("INSERT INTO review_executions VALUES (?,?,?,?,?,?,?)").run("rex_empty", RUN, "c0ffee", 1, "correctness", 1, JSON.stringify(value));
  let seq = 0;
  const event = (ts, type, payload) => {
    seq += 1;
    const id = `evt_${seq}`;
    db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?)").run(id, RUN, seq, ts, type, "system", JSON.stringify({ id, runId: RUN, seq, ts, type, payload, causedBy: [], actor: { kind: "system" }, artifacts: [] }));
  };
  event(1400, "review.started", { execution: value });
  event(1450, "model.call", { callId: "call_1", role: "reviewer", purpose: "review_correctness", usage: { inputTokens: 30, outputTokens: 10 } });
  event(1500, "review.finished", { execution: value });
  db.close();
  return CUTOFF;
}

function selfcheck() {
  const dir = mkdtempSync(join(tmpdir(), "p2-1-selfcheck-"));
  const path = join(dir, "polish.db");
  const emptyParsePath = join(dir, "empty-parse.db");
  try {
    const cutoff = buildSelfcheckStore(path);
    const data = read(path);
    const report = measure(data, cutoff);
    const v = verdict(report);
    const p = report.populations;
    const axis = (bucket, name) => p[bucket].axes[name] ?? emptyAxisRow();
    const emptyReport = measure(data, cutoff * 1000);
    const emptyVerdict = verdict(emptyReport);
    const emptyRender = render(emptyReport);
    let bucketedCalls = 0;
    for (const bucket of BUCKETS) {
      for (const row of Object.values(p[bucket].axes)) bucketedCalls += row.reviewerCalls;
    }
    const emptyParseCutoff = buildEmptyParseStore(emptyParsePath);
    const emptyParseReport = measure(read(emptyParsePath), emptyParseCutoff);
    const emptyParseVerdict = verdict(emptyParseReport);
    const emptyParseRender = render(emptyParseReport);
    const checks = [
      ["executions that finished after the cut-off are eligible", p.eligible.executions, 5],
      ["an execution with no review.finished is never eligible", p.unfinished.executions, 1],
      ["the unfinished execution is not counted as ineligible either", axis("ineligible", "adversarial").executions, 0],
      ["a finding follows its execution, not its own ts", axis("ineligible", "regression").findingsRaised, 1],
      ["that late-raised finding is not eligible", axis("eligible", "regression").findingsRaised, 0],
      ["its VALID validation is not eligible either", axis("eligible", "regression").survivedReproduction, 0],
      ["eligible findings are counted", axis("eligible", "correctness").findingsRaised, 3],
      ["a RAW finding has not survived triage", axis("eligible", "correctness").survivedTriage, 2],
      ["a VALID validation is reproduction survival", axis("eligible", "correctness").survivedReproduction, 1],
      ["a task from a valid finding is counted", axis("eligible", "correctness").tasksSpawned, 1],
      ["a call follows its execution, not its own ts", axis("eligible", "correctness").reviewerTokens, 10],
      ["the ineligible execution keeps its own call", axis("ineligible", "regression").reviewerTokens, 20],
      ["a null-usage call contributes 0 tokens and is counted", axis("unfinished", "adversarial").nullUsageCalls, 1],
      ["a call with no open execution is unattributed", axis("unattributed", "ghost").reviewerCalls, 1],
      ["a finding with no execution cause is unattributed", p.unattributed.findingStatuses.VALID, 2],
      ["an axis outside the three defaults is eligible too", axis("eligible", "architecture").findingsRaised, 1],
      ["the verdict sums every eligible axis, not a fixed three", v.eligibleFindings, 4],
      ["a non-empty eligible set is measured, not inconclusive", v.verdict, "measured"],
      ["a non-empty eligible set reports its table", v.eligibleTableReported, true],
      ["an execution row with no events is not unfinished", axis("unfinished", "performance").executions, 0],
      ["an execution row with no events cannot be classified", axis("unattributed", "performance").executions, 1],
      ["duplicate review.finished resolves to the earliest", axis("ineligible", "security").executions, 1],
      ["so a later duplicate finish does not make it eligible", axis("eligible", "security").executions, 0],
      ["a purpose with no review_ prefix names no axis", axis("eligible", "correctness").reviewerCalls, 1],
      ["and is counted under its raw purpose, unattributed", axis("unattributed", "purpose:correctness").reviewerTokens, 5],
      // AC2's render path: the same store measured with a cut-off nothing reaches must print the
      // verdict without the eligible table. Restoring the zero table would fail this.
      ["an empty eligible set is inconclusive", emptyVerdict.verdict, "inconclusive — no post-plumbing production findings"],
      ["an empty eligible set reports no table", emptyVerdict.eligibleTableReported, false],
      ["and the rendered report says so instead of tabulating zeros", emptyRender.includes("no per-axis yield table is reported"), true],
      ["the rendered empty report has no eligible axis table", emptyRender.split("Ineligible —")[0].includes("| axis |"), false],
      ["the execution row decides the axis, not the event payload", axis("eligible", "coupling").executions, 1],
      ["so the axis the event claimed gets nothing", axis("eligible", "performance").reviewerTokens, 0],
      ["and the claim is counted as an inconsistency", report.inconsistencies.reviewEventAxisMismatch, 2],
      ["malformed usage contributes no tokens", axis("eligible", "coupling").reviewerTokens, 0],
      ["malformed usage is counted, not dropped", axis("eligible", "coupling").malformedUsageCalls, 1],
      ["and it does not turn a total into a string", typeof report.reproduction.reviewerTokens.measured, "number"],
      ["an axis named __proto__ survives the dictionary", axis("eligible", "__proto__").reviewerTokens, 2],
      ["an axis named constructor survives it too", axis("eligible", "constructor").reviewerTokens, 4],
      ["a review event naming no known execution is counted", report.inconsistencies.reviewEventUnknownExecution, 1],
      ["a review event from another run is counted", report.inconsistencies.reviewEventRunMismatch, 1],
      ["and that foreign execution is left unclassified", axis("unattributed", "correctness").executions, 1],
      ["a finding citing two buckets is not assigned to either", axis("eligible", "correctness").findingsRaised, 3],
      ["it is unattributed", axis("unattributed", "correctness").findingsRaised, 2],
      ["and the ambiguity is counted", report.inconsistencies.ambiguousFindingCause, 1],
      ["every reviewer call is accounted for in some bucket", bucketedCalls, report.reproduction.reviewerCalls.measured],
      ["a REJECTED reproduction survived triage", axis("eligible", "correctness").survivedTriage, 2],
      ["but it did not survive reproduction", axis("eligible", "correctness").survivedReproduction, 1],
      ["and it is counted as rejected", axis("eligible", "correctness").rejectedByReproduction, 1],
      // MC3 is about an empty eligible SET of executions. A completed eligible execution that
      // parsed to no findings is a measured zero and must be reported as yield, not as absence.
      ["an eligible execution with an empty parse is not an empty set", emptyParseVerdict.eligibleExecutions, 1],
      ["so it is measured, not the MC3 verdict", emptyParseVerdict.verdict, "measured"],
      ["its per-axis table is reported", emptyParseVerdict.eligibleTableReported, true],
      ["and the report does not call it empty", emptyParseRender.includes("Eligible population: empty"), false],
      ["its tokens are attributed to it", emptyParseReport.populations.eligible.axes.correctness.reviewerTokens, 40],
    ];
    const failures = checks.filter(([, actual, expected]) => actual !== expected);
    for (const [name, actual, expected] of checks) {
      process.stdout.write(`${actual === expected ? "ok  " : "FAIL"} ${name} — expected ${expected}, got ${actual}\n`);
    }
    process.stdout.write(`\n${checks.length - failures.length}/${checks.length} selfcheck assertions hold\n`);
    return failures.length === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.selfcheck) {
  process.exit(selfcheck() ? 0 : 1);
}
const report = measure(read(args.store), args.cutoff);
const full = { ...report, ...verdict(report), mismatches: mismatches(report) };
process.stdout.write(args.json ? `${JSON.stringify(full, null, 2)}\n` : `${render(report)}\n`);
