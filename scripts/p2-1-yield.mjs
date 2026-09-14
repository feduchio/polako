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

function emptyPopulation() {
  return { axes: {}, executionIds: new Set(), runIds: new Set(), findingStatuses: {} };
}

function rowFor(population, axis) {
  population.axes[axis] ??= emptyAxisRow();
  return population.axes[axis];
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
  const finishedTs = new Map();
  const startedTs = new Map();
  for (const event of data.events) {
    const execution = event.value.payload?.execution;
    if (execution === undefined || typeof execution.id !== "string") continue;
    const map = event.type === "review.finished" ? finishedTs : event.type === "review.started" ? startedTs : null;
    if (map === null) continue;
    const prior = map.get(execution.id);
    if (prior === undefined || event.ts < prior) map.set(execution.id, event.ts);
  }

  const bucketOfExecution = new Map();
  for (const execution of data.executions) {
    const finished = finishedTs.get(execution.id);
    const bucket = finished === undefined ? "unfinished" : finished >= cutoff ? "eligible" : "ineligible";
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
    const executionId = (causesByEvent.get(event.id) ?? []).find((cause) => bucketOfExecution.has(cause));
    if (executionId !== undefined) executionOfFinding.set(finding.id, executionId);
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
    population.findingStatuses[finding.status] = (population.findingStatuses[finding.status] ?? 0) + 1;
    const row = rowFor(population, finding.value.axis ?? "unknown");
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
  const whole = { reviewerCalls: 0, nullUsageCalls: 0, tokens: 0, byPurpose: {} };
  const baselineRunsOnly = { reviewerCalls: 0, nullUsageCalls: 0, tokens: 0 };
  const openExecution = new Map();
  for (const event of data.events) {
    if (event.type === "review.started") {
      const execution = event.value.payload?.execution;
      if (execution !== undefined && typeof execution.id === "string") {
        openExecution.set(`${event.runId}\u0000${execution.axis}`, execution.id);
      }
      continue;
    }
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
    const executionId = openExecution.get(`${event.runId}\u0000${axis}`);
    const bucket = executionId === undefined ? "unattributed" : bucketOfExecution.get(executionId) ?? "unattributed";
    const row = rowFor(populations[bucket], axis);
    row.reviewerCalls += 1;
    row.reviewerTokens += tokens;
    if (usage === null) row.nullUsageCalls += 1;
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
      const counts = failuresByRun.get(event.runId) ?? { byErrorKind: {}, byPhase: {} };
      counts.byErrorKind[kind] = (counts.byErrorKind[kind] ?? 0) + 1;
      counts.byPhase[phase] = (counts.byPhase[phase] ?? 0) + 1;
      failuresByRun.set(event.runId, counts);
    }
  }
  const runAccounting = data.runs.map((run) => {
    const span = spanByRun.get(run.id);
    const failures = failuresByRun.get(run.id) ?? { byErrorKind: {}, byPhase: {} };
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
  const postCutoffFailures = { total: 0, byErrorKind: {}, byPhase: {} };
  for (const run of postCutoff) {
    for (const [kind, count] of Object.entries(run.failedCalls.byErrorKind)) {
      postCutoffFailures.byErrorKind[kind] = (postCutoffFailures.byErrorKind[kind] ?? 0) + count;
      postCutoffFailures.total += count;
    }
    for (const [phase, count] of Object.entries(run.failedCalls.byPhase)) {
      postCutoffFailures.byPhase[phase] = (postCutoffFailures.byPhase[phase] ?? 0) + count;
    }
  }

  const report = {
    cutoff,
    cutoffCommit: CUTOFF_COMMIT,
    cutoffIso: new Date(cutoff).toISOString(),
    populations: {},
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

function verdict(report) {
  const eligible = report.populations.eligible;
  const sums = totals(eligible);
  if (eligible.executions === 0 || sums.findingsRaised === 0) {
    return {
      verdict: "inconclusive — no post-plumbing production findings",
      eligibleExecutions: eligible.executions,
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
    "| axis | execs | completed | raw items | findings | triage | reproduced | rejected | uncertain | tasks | calls | null usage | tokens |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const axis of order) {
    const r = axes[axis];
    lines.push(
      `| ${axis} | ${r.executions} | ${r.completedExecutions} | ${r.rawFindingItems} | ${r.findingsRaised} | ${r.survivedTriage} | ${r.survivedReproduction} | ${r.rejectedByReproduction} | ${r.uncertain} | ${r.tasksSpawned} | ${r.reviewerCalls} | ${r.nullUsageCalls} | ${r.reviewerTokens} |`,
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
      unattributed: "Unattributed — no execution could be joined; never counted as eligible",
    }[bucket];
    out.push(`${label}. Executions: ${population.executions}. Runs: ${population.runs.join(", ") || "none"}`);
    out.push(renderAxisTable(population.axes));
    out.push(`finding statuses: ${JSON.stringify(population.findingStatuses)}`);
    out.push("");
  }
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

function selfcheck() {
  const dir = mkdtempSync(join(tmpdir(), "p2-1-selfcheck-"));
  const path = join(dir, "polish.db");
  try {
    const cutoff = buildSelfcheckStore(path);
    const report = measure(read(path), cutoff);
    const v = verdict(report);
    const p = report.populations;
    const axis = (bucket, name) => p[bucket].axes[name] ?? emptyAxisRow();
    const checks = [
      ["eligible executions are the two that finished after the cut-off", p.eligible.executions, 2],
      ["an execution with no review.finished is never eligible", p.unfinished.executions, 1],
      ["unfinished execution is not counted as ineligible either", p.ineligible.executions, 1],
      ["a finding follows its execution, not its own ts", axis("ineligible", "regression").findingsRaised, 1],
      ["that late-raised finding is not eligible", axis("eligible", "regression").findingsRaised, 0],
      ["its VALID validation is not eligible either", axis("eligible", "regression").survivedReproduction, 0],
      ["eligible findings are counted", axis("eligible", "correctness").findingsRaised, 2],
      ["a RAW finding has not survived triage", axis("eligible", "correctness").survivedTriage, 1],
      ["a VALID validation is reproduction survival", axis("eligible", "correctness").survivedReproduction, 1],
      ["a task from a valid finding is counted", axis("eligible", "correctness").tasksSpawned, 1],
      ["a call follows its execution, not its own ts", axis("eligible", "correctness").reviewerTokens, 10],
      ["the ineligible execution keeps its own call", axis("ineligible", "regression").reviewerTokens, 20],
      ["a null-usage call contributes 0 tokens and is counted", axis("unfinished", "adversarial").nullUsageCalls, 1],
      ["a call with no open execution is unattributed", axis("unattributed", "ghost").reviewerCalls, 1],
      ["a finding with no execution cause is unattributed", axis("unattributed", "correctness").findingsRaised, 1],
      ["an axis outside the three defaults is eligible too", axis("eligible", "architecture").findingsRaised, 1],
      ["the verdict sums every eligible axis, not a fixed three", v.eligibleFindings, 3],
      ["a non-empty eligible set is measured, not inconclusive", v.verdict, "measured"],
      ["a non-empty eligible set reports its table", v.eligibleTableReported, true],
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
