import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "../../domain/common.js";
import { defaultConfig } from "../../domain/config.js";
import type { Event } from "../../domain/event.js";
import type { Finding, FindingStatus, FindingValidation } from "../../domain/finding.js";
import type { ReviewExecution } from "../../domain/review.js";
import { emptyFindingCounts, type Checkpoint } from "../../domain/checkpoint.js";
import { FakeClock } from "../../shared/clock.js";
import { hashJson } from "../../shared/hash.js";
import { id } from "../../shared/ids.js";
import { openStore } from "../../store/index.js";
import { ModelBroker } from "../../broker/broker.js";
import { BudgetTracker, QuotaTracker } from "../../broker/quota.js";
import { ModelCatalog } from "../../broker/catalog.js";
import { SecretStore } from "../../broker/secrets.js";
import {
  budgetSnapshotFromUsage,
  buildPathologySample,
  detectCheckpointOscillation,
  detectDisagreement,
  detectFindingOscillation,
  detectNoProgress,
  detectStyleOnlyGrowth,
  disagreementRoundsOf,
  eventsThroughBoundary,
  foldModelCallUsage,
  foldPrefix,
  hashPathologySample,
  isObservationBoundary,
  pendingEnsembleOverride,
  provenC2RollbackTarget,
  executablePersistedRollbackTarget,
  resolveObservationBoundary,
  selectEligibleEnsemble,
  selectStrategy,
} from "./index.js";
import { PATHOLOGY_SAMPLE_VERSION, type CanonicalProgressVector, type PathologySample, type TaskWorkClassRecord } from "./types.js";

const NOW = 1_700_000_000_000;
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function progress(overrides: Partial<CanonicalProgressVector> = {}): CanonicalProgressVector {
  return {
    checkpointHash: HASH_A,
    evidence: {
      gates: { test: "pass" },
      testsPassed: 1,
      testsFailed: 0,
      testsTotal: 1,
      openValidatedFindings: emptyFindingCounts(),
      diffLinesFromBaseline: 1,
    },
    integratedTaskIds: [],
    resolvedValidBlockingFingerprints: [],
    successfulGateFingerprints: [`${HASH_A}:test:pass`],
    acceptedEvidenceRefs: [],
    cleanRoundKeys: [],
    ...overrides,
  };
}

function sample(index: number, overrides: Partial<PathologySample> = {}): PathologySample {
  const runId = overrides.runId ?? id("run", NOW);
  const boundaryEventId = overrides.boundaryEventId ?? id("evt", NOW + index);
  return {
    version: PATHOLOGY_SAMPLE_VERSION,
    runId,
    boundaryEventId,
    boundarySeq: index,
    observedAt: NOW + index,
    checkpointHash: HASH_A,
    findingObservations: [],
    progress: progress(),
    disagreementRounds: [],
    taskIds: [],
    taskWorkClasses: [],
    budget: {
      runTokens: 0,
      knownRunUsd: 0,
      unknownCostCalls: [],
      perTask: {},
      sourceWatermark: null,
      usageConflict: false,
      elapsedMs: index,
      limits: { maxRunTokens: null, maxRunUsd: null, maxTaskTokens: null, maxRunWallClockMinutes: null },
      unusedCliMetadata: { budgetTokens: null, budgetUsd: null, applied: false },
      exhaustedDimensions: [],
    },
    ...overrides,
  };
}

function statuses(runId: string, fingerprint: string, values: FindingStatus[]): PathologySample[] {
  return values.map((status, index) =>
    sample(index, {
      runId,
      findingObservations: [
        {
          fingerprint,
          status,
          blocking: true,
          severity: "high",
          checkpointHash: HASH_A,
          causalEventId: id("evt", NOW + 10 + index),
        },
      ],
    }),
  );
}

describe("C2 sliding-window detectors", () => {
  const runId = id("run", NOW);

  it("finding A,B,A,B is positive; monotonic, missing, and duplicate states are negative", () => {
    expect(detectFindingOscillation(statuses(runId, "fp1", ["VALID", "REJECTED", "VALID", "REJECTED"]), 4)).not.toBeNull();
    expect(detectFindingOscillation(statuses(runId, "fp1", ["RAW", "VALIDATING", "VALID", "RESOLVED"]), 4)).toBeNull();
    expect(detectFindingOscillation(statuses(runId, "fp1", ["VALID", "VALID", "VALID", "VALID"]), 4)).toBeNull();
    expect(detectFindingOscillation(statuses(runId, "fp1", ["VALID", "REJECTED", "VALID"]), 4)).toBeNull();
    const evenSix = statuses(runId, "fp1", ["VALID", "REJECTED", "VALID", "REJECTED", "VALID", "REJECTED"]);
    expect(detectFindingOscillation(evenSix, 6)).not.toBeNull();
    expect(detectFindingOscillation(evenSix, 5)).toBeNull();
  });

  it("checkpoint A,B,A,B is positive; stable, linear, and one rollback then progress are negative", () => {
    const oscillating = [HASH_A, HASH_B, HASH_A, HASH_B].map((hash, index) => sample(index, { runId, checkpointHash: hash }));
    expect(detectCheckpointOscillation(oscillating, 4)).not.toBeNull();
    const stable = [HASH_A, HASH_A, HASH_A, HASH_A].map((hash, index) => sample(index, { runId, checkpointHash: hash }));
    expect(detectCheckpointOscillation(stable, 4)).toBeNull();
    const linear = ["c".repeat(40), HASH_A, HASH_B, "d".repeat(40)].map((hash, index) => sample(index, { runId, checkpointHash: hash }));
    expect(detectCheckpointOscillation(linear, 4)).toBeNull();
    const rollbackThenProgress = [HASH_A, HASH_B, HASH_A, "e".repeat(40)].map((hash, index) =>
      sample(index, { runId, checkpointHash: hash }),
    );
    expect(detectCheckpointOscillation(rollbackThenProgress, 4)).toBeNull();
  });

  it("no-progress requires an unchanged vector; clean rounds and real improvement are negative", () => {
    const stuck = [0, 1, 2].map((index) => sample(index, { runId, progress: progress() }));
    expect(detectNoProgress(stuck, 3, false)).not.toBeNull();
    expect(detectNoProgress(stuck, 3, true)).toBeNull();
    const spendOnly = [0, 1, 2].map((index) =>
      sample(index, {
        runId,
        progress: progress(),
        budget: { ...sample(index).budget, runTokens: 100 * (index + 1) },
      }),
    );
    expect(detectNoProgress(spendOnly, 3, false)).not.toBeNull();
    const improved = [
      sample(0, { runId, progress: progress({ cleanRoundKeys: [] }) }),
      sample(1, { runId, progress: progress({ cleanRoundKeys: [] }) }),
      sample(2, { runId, progress: progress({ cleanRoundKeys: [`${HASH_A}:1:1`] }) }),
    ];
    expect(detectNoProgress(improved, 3, false)).toBeNull();
    const gateImproved = [
      sample(0, { runId, progress: progress({ successfulGateFingerprints: [] }) }),
      sample(1, { runId, progress: progress({ successfulGateFingerprints: [] }) }),
      sample(2, { runId, progress: progress({ successfulGateFingerprints: [`${HASH_A}:test:pass`] }) }),
    ];
    expect(detectNoProgress(gateImproved, 3, false)).toBeNull();
    const pair = [0, 1].map((index) => sample(index, { runId, progress: progress() }));
    expect(detectNoProgress([pair[0]!], 2, false)).toBeNull();
    expect(detectNoProgress(pair, 2, false)).not.toBeNull();
    expect(detectNoProgress(pair, 1, false)).toBeNull();
  });

  it("disagreement 2-of-3 non-shrinking is positive; shrinking, resolved, incomplete, and single-position are negative", () => {
    const positive = sample(2, {
      runId,
      checkpointHash: HASH_A,
      disagreementRounds: [
        { checkpointHash: HASH_A, roundIndex: 1, fingerprints: ["fp"] },
        { checkpointHash: HASH_A, roundIndex: 2, fingerprints: ["fp"] },
      ],
    });
    expect(detectDisagreement([positive], 2)).not.toBeNull();
    const shrinking = sample(2, {
      runId,
      checkpointHash: HASH_A,
      disagreementRounds: [
        { checkpointHash: HASH_A, roundIndex: 1, fingerprints: ["fp", "other"] },
        { checkpointHash: HASH_A, roundIndex: 2, fingerprints: ["fp"] },
      ],
    });
    expect(detectDisagreement([shrinking], 2)).toBeNull();
    const resolved = sample(2, {
      runId,
      checkpointHash: HASH_A,
      disagreementRounds: [
        { checkpointHash: HASH_A, roundIndex: 1, fingerprints: ["fp"] },
        { checkpointHash: HASH_A, roundIndex: 2, fingerprints: [] },
      ],
    });
    expect(detectDisagreement([resolved], 2)).toBeNull();
    const singleRound = sample(1, {
      runId,
      checkpointHash: HASH_A,
      disagreementRounds: [{ checkpointHash: HASH_A, roundIndex: 1, fingerprints: ["fp"] }],
    });
    expect(detectDisagreement([singleRound], 2)).toBeNull();
  });

  it("style-only simplify/refactor growth is positive; keyword, missing, investigation, and functional growth are negative", () => {
    const style: TaskWorkClassRecord = {
      taskId: "task_style",
      workClass: "style_only",
      classifiedBy: "planner",
      sourceRef: "R1",
      classificationEventId: id("evt", NOW),
      kind: "simplify",
      originKind: "mission_requirement",
    };
    const grown = [
      sample(0, { runId, taskIds: ["task_old"] }),
      sample(1, { runId, taskIds: ["task_old"] }),
      sample(2, { runId, taskIds: ["task_old", "task_style"], taskWorkClasses: [style] }),
    ];
    expect(detectStyleOnlyGrowth(grown, 3)).not.toBeNull();
    const missing = [
      sample(0, { runId, taskIds: ["task_old"] }),
      sample(1, { runId, taskIds: ["task_old"] }),
      sample(2, { runId, taskIds: ["task_old", "task_new"], taskWorkClasses: [] }),
    ];
    expect(detectStyleOnlyGrowth(missing, 3)).toBeNull();
    const investigation: TaskWorkClassRecord = { ...style, taskId: "task_inv", kind: "investigation", originKind: "investigation" };
    const inv = [
      sample(0, { runId, taskIds: ["task_old"] }),
      sample(1, { runId, taskIds: ["task_old"] }),
      sample(2, { runId, taskIds: ["task_old", "task_inv"], taskWorkClasses: [investigation] }),
    ];
    expect(detectStyleOnlyGrowth(inv, 3)).toBeNull();
    const functional: TaskWorkClassRecord = { ...style, taskId: "task_fn", workClass: "functional", kind: "feature" };
    const fn = [
      sample(0, { runId, taskIds: ["task_old"] }),
      sample(1, { runId, taskIds: ["task_old"] }),
      sample(2, { runId, taskIds: ["task_old", "task_fn"], taskWorkClasses: [functional] }),
    ];
    expect(detectStyleOnlyGrowth(fn, 3)).toBeNull();
  });

  it("selects NEEDS_HUMAN over ROLLBACK over CHANGE_ENSEMBLE and ties break by Pathology order", () => {
    const selected = selectStrategy({
      findings: [
        { kind: "finding_oscillation", sampleKeys: ["a"], evidenceRefs: [], reason: "osc" },
        { kind: "task_graph_growth_from_nonblocking", sampleKeys: ["a"], evidenceRefs: [], reason: "growth" },
      ],
      ensembleChangesByPathology: {
        finding_oscillation: 0,
        checkpoint_oscillation: 0,
        test_only_verification_treadmill: 0,
        no_progress: 0,
        disagreement_not_shrinking: 0,
        task_graph_growth_from_nonblocking: 0,
      },
      maxEnsembleChangesPerPathology: 1,
      eligibleEnsemble: [{ provider: "p", model: "alt" }],
      current: null,
      priorCheckpoints: [],
      nextReviewRoundIndex: 2,
    });
    expect(selected.action).toBe("NEEDS_HUMAN");
    expect(selected.owner?.kind).toBe("task_graph_growth_from_nonblocking");
  });

  it("CHANGE_ENSEMBLE is bounded, quality-floor-respecting, and targets one next review round", () => {
    const current = stubCheckpoint(HASH_A);
    const selected = selectStrategy({
      findings: [{ kind: "disagreement_not_shrinking", sampleKeys: ["a"], evidenceRefs: [], reason: "split" }],
      ensembleChangesByPathology: {
        finding_oscillation: 0,
        checkpoint_oscillation: 0,
        test_only_verification_treadmill: 0,
        no_progress: 0,
        disagreement_not_shrinking: 0,
        task_graph_growth_from_nonblocking: 0,
      },
      maxEnsembleChangesPerPathology: 1,
      eligibleEnsemble: [{ provider: "p", model: "alt" }],
      current,
      priorCheckpoints: [],
      nextReviewRoundIndex: 4,
    });
    expect(selected.action).toBe("CHANGE_ENSEMBLE");
    expect(selected.targetReviewRoundIndex).toBe(4);
    expect(selected.targetEnsemble).toEqual([{ provider: "p", model: "alt" }]);
    expect(selected.targetCheckpoint?.commitHash).toBe(HASH_A);

    const bounded = selectStrategy({
      findings: [{ kind: "disagreement_not_shrinking", sampleKeys: ["a"], evidenceRefs: [], reason: "split" }],
      ensembleChangesByPathology: {
        finding_oscillation: 0,
        checkpoint_oscillation: 0,
        test_only_verification_treadmill: 0,
        no_progress: 0,
        disagreement_not_shrinking: 1,
        task_graph_growth_from_nonblocking: 0,
      },
      maxEnsembleChangesPerPathology: 1,
      eligibleEnsemble: [{ provider: "p", model: "alt" }],
      current: null,
      priorCheckpoints: [],
      nextReviewRoundIndex: 4,
    });
    expect(bounded.action).toBe("NEEDS_HUMAN");

    const ensemble = selectEligibleEnsemble({
      options: [
        { ensemble: [{ provider: "p", model: "old" }], quality: 0.9 },
        { ensemble: [{ provider: "p", model: "new" }], quality: 0.9 },
        { ensemble: [{ provider: "p", model: "cheap" }], quality: 0.1 },
      ],
      previous: [],
      checkpointHash: HASH_A,
      axes: ["correctness"],
      minQualityForRotation: 0.6,
      currentEnsemble: [{ provider: "p", model: "old" }],
    });
    expect(ensemble).toEqual([{ provider: "p", model: "new" }]);
  });
});

describe("C2 budget fold", () => {
  function call(seq: number, payload: Record<string, unknown>): Event {
    return {
      schemaVersion: 1,
      id: id("evt", NOW + seq),
      runId: id("run", NOW),
      seq,
      ts: NOW + seq,
      type: "model.call",
      payload,
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    };
  }

  it("counts duplicate call ids once and treats null USD as unknown", () => {
    const events = [
      call(0, { callId: "c1", taskId: "t1", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2 } }),
      call(1, { callId: "c1", taskId: "t1", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2 } }),
      call(2, { callId: "c2", taskId: "t1", usage: { inputTokens: 3, outputTokens: 1, costUsd: null } }),
    ];
    const fold = foldModelCallUsage(events);
    expect(fold.runTokens).toBe(19);
    expect(fold.knownRunUsd).toBe(0.2);
    expect(fold.unknownCostCalls).toEqual(["c2"]);
    expect(fold.perTask).toEqual({ t1: 19 });
    expect(fold.usageConflict).toBe(false);
  });

  it("flags conflicting duplicate usage and still does not double-count", () => {
    const events = [
      call(0, { callId: "c1", usage: { inputTokens: 10, outputTokens: 0, costUsd: 1 } }),
      call(1, { callId: "c1", usage: { inputTokens: 99, outputTokens: 0, costUsd: 9 } }),
    ];
    const fold = foldModelCallUsage(events);
    expect(fold.runTokens).toBe(10);
    expect(fold.knownRunUsd).toBe(1);
    expect(fold.usageConflict).toBe(true);
  });

  it("exhausts token, USD, task-token, and wall-clock dimensions at equality", () => {
    const config = defaultConfig();
    config.budget.maxRunTokens = 15;
    config.budget.maxRunUsd = 0.2;
    config.budget.maxTaskTokens = 15;
    config.budget.maxRunWallClockMinutes = 1;
    const events = [call(0, { callId: "c1", taskId: "t1", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2 } })];
    const sampleRow = buildPathologySample({
      events: [
        {
          schemaVersion: 1,
          id: id("evt", NOW - 1),
          runId: events[0]!.runId,
          seq: 0,
          ts: NOW - 60_000,
          type: "run.created",
          payload: {
            run: {
              id: events[0]!.runId,
              createdAt: NOW - 60_000,
              currentCheckpointHash: HASH_A,
              missionId: id("msn", NOW),
            },
          },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
        { ...events[0]!, seq: 1 },
      ],
      boundary: { ...events[0]!, seq: 1 },
      config,
    });
    expect(sampleRow.budget.exhaustedDimensions.sort()).toEqual(["run_tokens", "run_usd", "task_tokens:t1", "wall_clock"].sort());
  });
});

describe("C2 sample replay and broker fold equality", () => {
  it("same prefix projected twice, including after reconstruction, yields identical hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-c2-"));
    cleanup.push(dir);
    const store = openStore({ home: dir });
    const runId = id("run", NOW);
    const boundaryId = id("evt", NOW + 2);
    store.events.append([
      {
        id: id("evt", NOW),
        runId,
        ts: NOW,
        type: "run.created",
        payload: {
          run: {
            id: runId,
            missionId: id("msn", NOW),
            projectPath: "/tmp/p",
            runBranch: "run",
            phase: "CONVERGENCE_CHECK",
            control: "RUNNING",
            currentCheckpointHash: HASH_A,
            baselineId: null,
            interpretationId: null,
            createdAt: NOW,
            updatedAt: NOW,
            terminalReason: null,
          },
        },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
      {
        id: boundaryId,
        runId,
        ts: NOW + 2,
        type: "checkpoint.created",
        payload: {
          checkpoint: {
            id: id("cp", NOW),
            runId,
            seq: 0,
            commitHash: HASH_A,
            parentId: null,
            source: "baseline",
            taskId: null,
            evidence: progress().evidence,
            createdAt: NOW,
          },
        },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
    const events = store.events.list(runId);
    const first = buildPathologySample({ events, boundary: events[1]!, config: defaultConfig() });
    const second = buildPathologySample({ events, boundary: events[1]!, config: defaultConfig() });
    expect(hashPathologySample(first)).toBe(hashPathologySample(second));
    store.close();
    const rebuilt = openStore({ home: dir });
    const again = buildPathologySample({
      events: rebuilt.events.list(runId),
      boundary: rebuilt.events.list(runId)[1]!,
      config: defaultConfig(),
    });
    expect(hashPathologySample(again)).toBe(hashPathologySample(first));
    rebuilt.close();
  });

  it("BrokerService.restore snapshot equals the C2 canonical fold, including duplicates and conflicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-c2-fold-"));
    cleanup.push(dir);
    const store = openStore({ artifactsDir: join(dir, "a") });
    const clock = new FakeClock(NOW);
    const runId = id("run", NOW);
    store.events.append([
      {
        id: id("evt", NOW),
        runId,
        ts: NOW,
        type: "run.created",
        payload: {
          run: {
            id: runId,
            missionId: id("msn", NOW),
            projectPath: "/tmp/p",
            runBranch: "run",
            phase: "CONVERGENCE_CHECK",
            control: "RUNNING",
            currentCheckpointHash: null,
            baselineId: null,
            interpretationId: null,
            createdAt: NOW,
            updatedAt: NOW,
            terminalReason: null,
          },
        },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
      {
        id: id("evt", NOW + 1),
        runId,
        ts: NOW + 1,
        type: "model.call",
        payload: { callId: "dup", taskId: "t1", usage: { inputTokens: 4, outputTokens: 1, costUsd: 0.5 } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
      {
        id: id("evt", NOW + 2),
        runId,
        ts: NOW + 2,
        type: "model.call",
        payload: { callId: "dup", taskId: "t1", usage: { inputTokens: 99, outputTokens: 1, costUsd: 9 } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
      {
        id: id("evt", NOW + 3),
        runId,
        ts: NOW + 3,
        type: "model.call",
        payload: { callId: "null-usd", usage: { inputTokens: 2, outputTokens: 0, costUsd: null } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
    const fold = foldModelCallUsage(store.events.list(runId));
    const budget = new BudgetTracker({ maxRunUsd: null, maxRunTokens: null, maxTaskTokens: null });
    const broker = new ModelBroker({
      store,
      clock,
      catalog: new ModelCatalog(),
      quota: new QuotaTracker(clock, { concurrency: 1, rpm: null }),
      budget,
      secrets: SecretStore.fromValues({}),
    });
    broker.restore(runId);
    expect(budget.snapshot(runId)).toEqual(budgetSnapshotFromUsage(fold));
    expect(fold.usageConflict).toBe(true);
    expect(fold.unknownCostCalls).toEqual(["null-usd"]);
    expect(hashJson(budget.snapshot(runId))).toBe(hashJson(budgetSnapshotFromUsage(fold)));
    store.close();
  });

  it("observation boundaries ignore polling events and do not fall back to the last event", () => {
    const runId = id("run", NOW);
    const checkpoint: Event = {
      schemaVersion: 1,
      id: id("evt", NOW),
      runId,
      ts: NOW,
      seq: 1,
      type: "checkpoint.created",
      payload: {},
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    };
    const idle: Event = {
      schemaVersion: 1,
      id: id("evt", NOW + 1),
      runId,
      ts: NOW + 1,
      seq: 2,
      type: "run.phase_changed",
      payload: {},
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    };
    expect(resolveObservationBoundary([checkpoint, idle])?.id).toBe(checkpoint.id);
    expect(resolveObservationBoundary([idle])).toBeNull();
  });

  it("treats a review round as complete only at reviewersPerRound independent reviews", () => {
    const runId = id("run", NOW);
    const first = reviewFinished(runId, 1, 1, "m1", "correctness");
    const second = reviewFinished(runId, 2, 1, "m2", "regression");
    const third = reviewFinished(runId, 3, 1, "m3", "adversarial");
    const required = defaultConfig().review.reviewersPerRound;
    expect(required).toBe(3);
    expect(isObservationBoundary(first, [first], required)).toBe(false);
    expect(isObservationBoundary(second, [first, second], required)).toBe(false);
    expect(isObservationBoundary(third, [first, second, third], required)).toBe(true);
    expect(resolveObservationBoundary([first, second], required)).toBeNull();
    expect(resolveObservationBoundary([first, second, third], required)?.id).toBe(third.id);
  });

  it("does not treat an in-progress validation pass as a boundary while RAW findings remain", () => {
    const runId = id("run", NOW);
    const first = { ...splitFinding(runId), status: "RAW" as const };
    const second = { ...splitFinding(runId), id: id("find", NOW + 1), fingerprint: "fp-open", status: "RAW" as const };
    const raisedFirst = findingRaised(runId, 1, first);
    const raisedSecond = findingRaised(runId, 2, second);
    const validated = findingValidated(runId, 3, { ...first, status: "REJECTED" }, "REJECTED", "v1");
    expect(isObservationBoundary(validated, [raisedFirst, raisedSecond, validated], 3)).toBe(false);
    expect(resolveObservationBoundary([raisedFirst, raisedSecond, validated], 3)).toBeNull();
  });

  it("includes one evidence-agent finding.validated in the sample after a completed validation pass", () => {
    const runId = id("run", NOW);
    const finding = { ...splitFinding(runId), status: "RAW" as const };
    const raised = findingRaised(runId, 1, finding);
    const reviews = [
      reviewFinished(runId, 2, 1, "m1", "correctness"),
      reviewFinished(runId, 3, 1, "m2", "regression"),
      reviewFinished(runId, 4, 1, "m3", "adversarial"),
    ];
    const validated = findingValidated(runId, 5, { ...finding, status: "REJECTED" }, "REJECTED", "evidence", {
      kind: "evidence_agent",
    });
    const events = [raised, ...reviews, validated];
    expect(isObservationBoundary(validated, events, 3)).toBe(true);
    const boundary = resolveObservationBoundary(events, 3);
    expect(boundary?.id).toBe(validated.id);
    const prefix = eventsThroughBoundary(events, boundary!.id);
    expect(prefix.some((event) => event.type === "finding.validated")).toBe(true);
    expect(foldPrefix(prefix).validations).toHaveLength(1);
    const sampleRow = buildPathologySample({ events, boundary: boundary!, config: defaultConfig() });
    expect(sampleRow.findingObservations.some((row) => row.status === "REJECTED" && row.causalEventId === validated.id)).toBe(true);
  });

  it("ignores a CHANGE_ENSEMBLE override when the checkpoint hash differs", () => {
    const runId = id("run", NOW);
    const events = changeEnsembleEvents(runId, HASH_A, 1);
    expect(pendingEnsembleOverride(events, HASH_A, 1)).toEqual([{ provider: "p", model: "alt" }]);
    expect(pendingEnsembleOverride(events, HASH_B, 1)).toBeNull();
  });

  it("omits incomplete review rounds from disagreement positives", () => {
    const runId = id("run", NOW);
    const finding = splitFinding(runId);
    const raised = findingRaised(runId, 1, finding);
    const oneReview = reviewFinished(runId, 2, 1, "m1", "correctness");
    const valid = findingValidated(runId, 3, finding, "VALID", "v1");
    const rejected = findingValidated(runId, 4, { ...finding, status: "REJECTED" }, "REJECTED", "v2");
    const incomplete = foldPrefix([raised, oneReview, valid, rejected]);
    expect(disagreementRoundsOf(incomplete, 3)).toEqual([]);

    const reviews = [
      reviewFinished(runId, 2, 1, "m1", "correctness"),
      reviewFinished(runId, 3, 1, "m2", "regression"),
      reviewFinished(runId, 4, 1, "m3", "adversarial"),
    ];
    const complete = foldPrefix([raised, ...reviews, valid, rejected]);
    expect(disagreementRoundsOf(complete, 3)).toEqual([
      { checkpointHash: HASH_A, roundIndex: 1, fingerprints: [finding.fingerprint] },
    ]);
    expect(disagreementRoundsOf(complete, 1)[0]?.fingerprints).toEqual([finding.fingerprint]);
  });

  it("does not treat one reviewer flip-flop in a completed round as disagreement", () => {
    const runId = id("run", NOW);
    const finding = splitFinding(runId);
    const raised = findingRaised(runId, 1, finding);
    const reviews = [
      reviewFinished(runId, 2, 1, "m1", "correctness"),
      reviewFinished(runId, 3, 1, "m2", "regression"),
      reviewFinished(runId, 4, 1, "m3", "adversarial"),
    ];
    const valid = findingValidated(runId, 5, finding, "VALID", "same-reviewer");
    const rejected = findingValidated(runId, 6, { ...finding, status: "REJECTED" }, "REJECTED", "same-reviewer");
    expect(disagreementRoundsOf(foldPrefix([raised, ...reviews, valid, rejected]), 3)).toEqual([
      { checkpointHash: HASH_A, roundIndex: 1, fingerprints: [] },
    ]);
  });

  it("persisted rollback execute keeps the exact hash and refuses a worse target", () => {
    const runId = id("run", NOW);
    const current = {
      id: id("cp", NOW + 2),
      runId,
      seq: 2,
      commitHash: HASH_B,
      parentId: null,
      source: "integration" as const,
      taskId: null,
      evidence: {
        gates: { test: "pass" as const },
        testsPassed: 1,
        testsFailed: 0,
        testsTotal: 1,
        openValidatedFindings: emptyFindingCounts(),
        diffLinesFromBaseline: 3,
      },
      createdAt: NOW + 2,
    };
    const worse = {
      ...current,
      id: id("cp", NOW),
      seq: 0,
      commitHash: HASH_A,
      evidence: { ...current.evidence, testsPassed: 0, testsFailed: 1 },
    };
    const better = {
      ...current,
      id: id("cp", NOW + 1),
      seq: 1,
      commitHash: "c".repeat(40),
      evidence: { ...current.evidence, testsPassed: 3 },
    };
    expect(executablePersistedRollbackTarget(current, worse)).toBeNull();
    expect(executablePersistedRollbackTarget(current, better)?.commitHash).toBe(better.commitHash);
    expect(provenC2RollbackTarget(current, [worse, better])?.commitHash).toBe(better.commitHash);
  });

  it("refuses rollback targets with fail/error/timeout gates", () => {
    const current = {
      id: id("cp", NOW + 1),
      runId: id("run", NOW),
      seq: 1,
      commitHash: HASH_B,
      parentId: null,
      source: "integration" as const,
      taskId: null,
      evidence: {
        gates: { test: "fail" as const },
        testsPassed: 0,
        testsFailed: 1,
        testsTotal: 1,
        openValidatedFindings: emptyFindingCounts(),
        diffLinesFromBaseline: 3,
      },
      createdAt: NOW + 1,
    };
    const priorFail = {
      ...current,
      id: id("cp", NOW),
      seq: 0,
      commitHash: HASH_A,
      evidence: {
        ...current.evidence,
        gates: { test: "timeout" as const },
        testsPassed: 2,
        testsFailed: 0,
      },
    };
    expect(provenC2RollbackTarget(current, [priorFail])).toBeNull();
  });
});

function reviewFinished(
  runId: string,
  seq: number,
  roundIndex: number,
  model: string,
  axis: ReviewExecution["axis"],
): Event {
  const execution: ReviewExecution = {
    id: id("rvex", NOW + seq),
    runId,
    checkpointHash: HASH_A,
    roundIndex,
    axis,
    requestedModel: { provider: "p", model },
    completed: true,
    findings: [],
    startedAt: NOW + seq,
    finishedAt: NOW + seq,
  };
  return {
    schemaVersion: 1,
    id: id("evt", NOW + seq),
    runId,
    ts: NOW + seq,
    seq,
    type: "review.finished",
    payload: { execution },
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  };
}

function splitFinding(runId: string): Finding {
  return {
    id: id("find", NOW),
    runId,
    checkpointHash: HASH_A,
    axis: "correctness",
    reportedBy: { kind: "reviewer", model: { provider: "p", model: "m1" } },
    status: "VALID",
    duplicateOf: null,
    fingerprint: "fp-split",
    investigationRounds: 0,
    criterion: "x",
    severity: "high",
    blocking: true,
    claim: "disputed",
    evidence: [],
    reproduction: ["x"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function findingRaised(runId: string, seq: number, finding: Finding): Event {
  return {
    schemaVersion: 1,
    id: id("evt", NOW + seq),
    runId,
    ts: NOW + seq,
    seq,
    type: "finding.raised",
    payload: { finding },
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  };
}

function stubCheckpoint(commitHash: string): Checkpoint {
  const evidence = progress().evidence;
  if (evidence === null) throw new Error("expected evidence");
  return {
    id: id("cp", NOW),
    runId: id("run", NOW),
    seq: 0,
    commitHash,
    parentId: null,
    source: "baseline",
    taskId: null,
    evidence,
    createdAt: NOW,
  };
}

function changeEnsembleEvents(runId: string, checkpointHash: string, roundIndex: number): Event[] {
  const boundaryId = id("evt", NOW);
  return [
    {
      schemaVersion: 1,
      id: id("evt", NOW + 1),
      runId,
      ts: NOW + 1,
      seq: 1,
      type: "pathology.decision",
      payload: {
        decision: {
          version: 1,
          runId,
          boundaryEventId: boundaryId,
          decisionVersion: 1,
          findings: [],
          action: "CHANGE_ENSEMBLE",
          reason: "rotate",
          budget: sample(0).budget,
          targetCheckpointHash: checkpointHash,
          targetEnsemble: [{ provider: "p", model: "alt" }],
          targetReviewRoundIndex: roundIndex,
          causalEventIds: [boundaryId],
        },
      },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      schemaVersion: 1,
      id: id("evt", NOW + 2),
      runId,
      ts: NOW + 2,
      seq: 2,
      type: "pathology.effect_completed",
      payload: { boundaryEventId: boundaryId },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ];
}

function findingValidated(
  runId: string,
  seq: number,
  finding: Finding,
  verdict: FindingValidation["verdict"],
  model: string,
  performedBy?: Actor,
): Event {
  const validation: FindingValidation = {
    id: id("fval", NOW + seq),
    findingId: finding.id,
    runId,
    method: "independent_reviewer_agreement",
    verdict,
    rationale: verdict,
    evidenceRefs: [{ sha256: "a".repeat(64), kind: "check_output", bytes: 1 }],
    performedBy: performedBy ?? { kind: "reviewer", model: { provider: "p", model } },
    createdAt: NOW + seq,
  };
  return {
    schemaVersion: 1,
    id: id("evt", NOW + seq),
    runId,
    ts: NOW + seq,
    seq,
    type: "finding.validated",
    payload: { finding, validation },
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  };
}
