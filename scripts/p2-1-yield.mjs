#!/usr/bin/env node
// P2.1 — post-validation yield. Read-only measurement over a Polish store.
// Contract: docs/ledger/P2.1.md. Run: node scripts/p2-1-yield.mjs [--store PATH] [--cutoff MS] [--json]
//
// The store is opened read-only and never through src/store/db.ts openDb, which migrates
// and would write. Nothing here is production code; it is an instrument whose output is a report.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

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

const AXES = ["correctness", "regression", "adversarial"];

function parseArgs(argv) {
  const out = { store: join(homedir(), ".polish", "polish.db"), cutoff: DEFAULT_CUTOFF_MS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--store") out.store = argv[++i];
    else if (arg === "--cutoff") out.cutoff = Number(argv[++i]);
    else if (arg.startsWith("--store=")) out.store = arg.slice("--store=".length);
    else if (arg.startsWith("--cutoff=")) out.cutoff = Number(arg.slice("--cutoff=".length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.cutoff)) throw new Error(`--cutoff must be epoch milliseconds, got ${out.cutoff}`);
  return out;
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
    reviewerTokens: 0,
  };
}

function axisTable() {
  const table = {};
  for (const axis of AXES) table[axis] = emptyAxisRow();
  return table;
}

function rowFor(table, axis) {
  table[axis] ??= emptyAxisRow();
  return table[axis];
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
        value: JSON.parse(r.json),
      })),
      tasks: all("SELECT id, run_id, state, json FROM tasks").map((r) => ({
        id: r.id,
        runId: r.run_id,
        state: r.state,
        value: JSON.parse(r.json),
      })),
      events: all(
        "SELECT run_id, seq, ts, type, json FROM events WHERE type IN ('review.started','review.finished','model.call','finding.raised','run.phase_changed','model.observation.recorded') ORDER BY run_id, seq",
      ).map((r) => ({ runId: r.run_id, seq: r.seq, ts: r.ts, type: r.type, value: JSON.parse(r.json) })),
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
  // review.finished carries the execution that MC1 decides eligibility on. An execution with no
  // review.finished event was never parsed at all, so it is attributed to review.started's ts.
  const finishedTs = new Map();
  const startedTs = new Map();
  for (const event of data.events) {
    const execution = event.value.payload?.execution;
    if (execution === undefined) continue;
    if (event.type === "review.finished") {
      const prior = finishedTs.get(execution.id);
      if (prior === undefined || event.ts < prior) finishedTs.set(execution.id, event.ts);
    } else if (event.type === "review.started") {
      const prior = startedTs.get(execution.id);
      if (prior === undefined || event.ts < prior) startedTs.set(execution.id, event.ts);
    }
  }

  const eligible = { axes: axisTable(), executionIds: new Set(), runIds: new Set(), noEventTs: 0 };
  const ineligible = { axes: axisTable(), executionIds: new Set(), runIds: new Set(), noEventTs: 0 };

  for (const execution of data.executions) {
    const ts = finishedTs.get(execution.id) ?? startedTs.get(execution.id);
    const side = ts !== undefined && ts >= cutoff ? eligible : ineligible;
    if (ts === undefined) side.noEventTs += 1;
    side.executionIds.add(execution.id);
    side.runIds.add(execution.runId);
    const row = rowFor(side.axes, execution.axis);
    row.executions += 1;
    if (execution.completed) row.completedExecutions += 1;
    row.rawFindingItems += Array.isArray(execution.value.findings) ? execution.value.findings.length : 0;
  }

  // A finding is attributed to the population its own finding.raised event falls in, for the same
  // reason MC1 gives: what matters is when the response was parsed, not which run it belonged to.
  const raisedTs = new Map();
  for (const event of data.events) {
    if (event.type !== "finding.raised") continue;
    const finding = event.value.payload?.finding;
    if (finding === undefined) continue;
    const prior = raisedTs.get(finding.id);
    if (prior === undefined || event.ts < prior) raisedTs.set(finding.id, event.ts);
  }

  const validationsByFinding = new Map();
  for (const validation of data.validations) {
    const list = validationsByFinding.get(validation.findingId) ?? [];
    list.push(validation);
    validationsByFinding.set(validation.findingId, list);
  }

  const tasksByFinding = new Map();
  for (const task of data.tasks) {
    const origin = task.value.origin;
    const findingId = origin?.findingId;
    if (typeof findingId !== "string") continue;
    const list = tasksByFinding.get(findingId) ?? [];
    list.push(task);
    tasksByFinding.set(findingId, list);
  }

  const findingStatuses = { eligible: {}, ineligible: {} };
  for (const finding of data.findings) {
    const ts = raisedTs.get(finding.id) ?? finding.value.createdAt;
    const isEligible = typeof ts === "number" && ts >= cutoff;
    const side = isEligible ? eligible : ineligible;
    const statuses = isEligible ? findingStatuses.eligible : findingStatuses.ineligible;
    statuses[finding.status] = (statuses[finding.status] ?? 0) + 1;
    const row = rowFor(side.axes, finding.value.axis);
    row.findingsRaised += 1;
    const validations = validationsByFinding.get(finding.id) ?? [];
    // Triage survival is observable two ways and they must agree: a validation row exists only for
    // triage disposition "validate" (src/findings/validator.ts:95-98), and DUPLICATE/NOTED are the
    // two dispositions that stop there.
    if (validations.length > 0 || !["DUPLICATE", "NOTED"].includes(finding.status)) row.survivedTriage += 1;
    if (validations.some((v) => v.verdict === "VALID")) row.survivedReproduction += 1;
    if (validations.some((v) => v.verdict === "REJECTED")) row.rejectedByReproduction += 1;
    if (validations.some((v) => v.verdict === "UNCERTAIN")) row.uncertain += 1;
    row.tasksSpawned += (tasksByFinding.get(finding.id) ?? []).length;
  }

  // Reviewer tokens. Same attribution rule as docs/PLAN.md §1: role reviewer, axis from purpose
  // with the review_ prefix removed, null usage contributes 0 tokens and is counted separately.
  const whole = { reviewerCalls: 0, nullUsageCalls: 0, tokens: 0, byPurpose: {} };
  const baselineRunsOnly = { reviewerCalls: 0, nullUsageCalls: 0, tokens: 0 };
  for (const event of data.events) {
    if (event.type !== "model.call") continue;
    const payload = event.value.payload ?? {};
    if (payload.role !== "reviewer") continue;
    const purpose = typeof payload.purpose === "string" ? payload.purpose : "unknown";
    const axis = purpose.startsWith("review_") ? purpose.slice("review_".length) : purpose;
    const usage = payload.usage ?? null;
    const tokens = usage === null ? 0 : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    whole.reviewerCalls += 1;
    whole.tokens += tokens;
    if (usage === null) whole.nullUsageCalls += 1;
    whole.byPurpose[purpose] = (whole.byPurpose[purpose] ?? 0) + tokens;
    if (BASELINE_RUNS.includes(event.runId)) {
      baselineRunsOnly.reviewerCalls += 1;
      baselineRunsOnly.tokens += tokens;
      if (usage === null) baselineRunsOnly.nullUsageCalls += 1;
    }
    const side = event.ts >= cutoff ? eligible : ineligible;
    const row = rowFor(side.axes, axis);
    row.reviewerCalls += 1;
    row.reviewerTokens += tokens;
    if (usage === null) row.nullUsageCalls += 1;
  }

  const completedExecutions = data.executions.filter((e) => e.completed).length;

  // Why the eligible set is what it is: a run started after the cut-off contributes eligible
  // executions only if it reached REVIEWING at all. Without this, an empty eligible set cannot be
  // told apart from "nothing has run since the fix".
  const spanByRun = new Map(data.runSpans.map((span) => [span.runId, span]));
  const phasesByRun = new Map();
  const errorKindsByRun = new Map();
  for (const event of data.events) {
    if (event.type === "run.phase_changed") {
      const phase = event.value.payload?.run?.phase;
      if (typeof phase !== "string") continue;
      const set = phasesByRun.get(event.runId) ?? new Set();
      set.add(phase);
      phasesByRun.set(event.runId, set);
    } else if (event.type === "model.observation.recorded") {
      const outcome = event.value.payload?.observation?.outcome;
      if (outcome === undefined || outcome.ok !== false) continue;
      const kind = typeof outcome.errorKind === "string" ? outcome.errorKind : "unknown";
      const counts = errorKindsByRun.get(event.runId) ?? {};
      counts[kind] = (counts[kind] ?? 0) + 1;
      errorKindsByRun.set(event.runId, counts);
    }
  }
  const runAccounting = data.runs.map((run) => {
    const span = spanByRun.get(run.id);
    return {
      runId: run.id,
      phase: run.phase,
      control: run.control,
      firstEventTs: span?.firstTs ?? null,
      lastEventTs: span?.lastTs ?? null,
      startedAfterCutoff: span !== undefined && span.firstTs >= cutoff,
      reachedReviewing: data.reviewedRuns.has(run.id),
      phasesReached: [...(phasesByRun.get(run.id) ?? [])],
      failedCallsByErrorKind: errorKindsByRun.get(run.id) ?? {},
    };
  });
  const postCutoff = runAccounting.filter((run) => run.startedAfterCutoff);
  const postCutoffErrorKinds = {};
  for (const run of postCutoff) {
    for (const [kind, count] of Object.entries(run.failedCallsByErrorKind)) {
      postCutoffErrorKinds[kind] = (postCutoffErrorKinds[kind] ?? 0) + count;
    }
  }

  return {
    cutoff,
    cutoffCommit: CUTOFF_COMMIT,
    cutoffIso: new Date(cutoff).toISOString(),
    eligible: {
      executions: eligible.executionIds.size,
      runs: [...eligible.runIds].sort(),
      executionsWithoutEventTs: eligible.noEventTs,
      axes: eligible.axes,
      findingStatuses: findingStatuses.eligible,
    },
    ineligible: {
      executions: ineligible.executionIds.size,
      runs: [...ineligible.runIds].sort(),
      executionsWithoutEventTs: ineligible.noEventTs,
      axes: ineligible.axes,
      findingStatuses: findingStatuses.ineligible,
    },
    reproduction: {
      reviewerCalls: { expected: EXPECTED.reviewerCalls, measured: whole.reviewerCalls },
      reviewerNullUsageCalls: { expected: EXPECTED.reviewerNullUsageCalls, measured: whole.nullUsageCalls },
      reviewerTokens: { expected: EXPECTED.reviewerTokens, measured: whole.tokens },
      completedReviewExecutions: { expected: EXPECTED.completedReviewExecutions, measured: completedExecutions },
      baselineRunsOnly,
      reviewerTokensByPurpose: whole.byPurpose,
    },
    store: {
      runs: data.runs.length,
      reviewExecutions: data.executions.length,
      executionsNeverFinished: data.executions.length - finishedTs.size,
      findings: data.findings.length,
      validations: data.validations.length,
      tasks: data.tasks.length,
    },
    runs: {
      total: runAccounting.length,
      startedAfterCutoff: postCutoff.length,
      startedAfterCutoffAndReviewed: postCutoff.filter((run) => run.reachedReviewing).length,
      postCutoffDeepestPhases: [...new Set(postCutoff.flatMap((run) => run.phasesReached))],
      postCutoffFailedCallsByErrorKind: postCutoffErrorKinds,
      detail: runAccounting,
    },
  };
}

function verdict(report) {
  const eligibleFindings = AXES.reduce((sum, axis) => sum + (report.eligible.axes[axis]?.findingsRaised ?? 0), 0);
  if (report.eligible.executions === 0 || eligibleFindings === 0) {
    return {
      verdict: "inconclusive — no post-plumbing production findings",
      eligibleExecutions: report.eligible.executions,
      eligibleFindings,
    };
  }
  return { verdict: "measured", eligibleExecutions: report.eligible.executions, eligibleFindings };
}

function mismatches(report) {
  const out = [];
  for (const [name, pair] of Object.entries(report.reproduction)) {
    if (typeof pair !== "object" || pair === null || !("expected" in pair)) continue;
    if (pair.expected !== pair.measured) out.push({ name, ...pair });
  }
  return out;
}

function renderAxisTable(axes) {
  const header = "| axis | execs | completed | raw items | findings | triage | reproduced | tasks | calls | null usage | tokens |";
  const lines = [header, "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const axis of AXES) {
    const r = axes[axis] ?? emptyAxisRow();
    lines.push(
      `| ${axis} | ${r.executions} | ${r.completedExecutions} | ${r.rawFindingItems} | ${r.findingsRaised} | ${r.survivedTriage} | ${r.survivedReproduction} | ${r.tasksSpawned} | ${r.reviewerCalls} | ${r.nullUsageCalls} | ${r.reviewerTokens} |`,
    );
  }
  for (const axis of Object.keys(axes)) {
    if (AXES.includes(axis)) continue;
    const r = axes[axis];
    lines.push(
      `| ${axis} (unexpected) | ${r.executions} | ${r.completedExecutions} | ${r.rawFindingItems} | ${r.findingsRaised} | ${r.survivedTriage} | ${r.survivedReproduction} | ${r.tasksSpawned} | ${r.reviewerCalls} | ${r.nullUsageCalls} | ${r.reviewerTokens} |`,
    );
  }
  return lines.join("\n");
}

function render(report) {
  const v = verdict(report);
  const bad = mismatches(report);
  const out = [];
  out.push(`P2.1 post-validation yield`);
  out.push(`cut-off: ${report.cutoffCommit} @ ${report.cutoff} (${report.cutoffIso})`);
  out.push(`store: ${report.store.runs} runs, ${report.store.reviewExecutions} review executions (${report.store.executionsNeverFinished} never finished), ${report.store.findings} findings, ${report.store.validations} validations, ${report.store.tasks} tasks`);
  out.push("");
  out.push(`VERDICT: ${v.verdict}`);
  out.push(`eligible review executions: ${v.eligibleExecutions}; eligible findings raised: ${v.eligibleFindings}`);
  out.push(
    `runs: ${report.runs.total} total, ${report.runs.startedAfterCutoff} started after the cut-off, ${report.runs.startedAfterCutoffAndReviewed} of those reached REVIEWING`,
  );
  out.push(`phases reached by post-cut-off runs: ${report.runs.postCutoffDeepestPhases.join(", ") || "none"}`);
  out.push(`failed provider calls in post-cut-off runs, by error kind: ${JSON.stringify(report.runs.postCutoffFailedCallsByErrorKind)}`);
  out.push("");
  out.push(`Eligible population (at or after the cut-off), runs: ${report.eligible.runs.length === 0 ? "none" : report.eligible.runs.join(", ")}`);
  out.push(renderAxisTable(report.eligible.axes));
  out.push(`eligible finding statuses: ${JSON.stringify(report.eligible.findingStatuses)}`);
  out.push("");
  out.push(`Ineligible population (before the cut-off; discarded parser output), runs: ${report.ineligible.runs.length === 0 ? "none" : report.ineligible.runs.join(", ")}`);
  out.push(renderAxisTable(report.ineligible.axes));
  out.push(`ineligible finding statuses: ${JSON.stringify(report.ineligible.findingStatuses)}`);
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

const args = parseArgs(process.argv.slice(2));
const report = measure(read(args.store), args.cutoff);
const full = { ...report, ...verdict(report), mismatches: mismatches(report) };
process.stdout.write(args.json ? `${JSON.stringify(full, null, 2)}\n` : `${render(report)}\n`);
