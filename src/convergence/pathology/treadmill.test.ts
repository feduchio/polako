import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../domain/config.js";
import type { PathologySample } from "./types.js";
import { classifyCheckpointPaths } from "./changeClassification.js";
import { detectTestOnlyTreadmill, runDetectors } from "./detectors.js";
import { selectStrategy } from "./strategy.js";
import { buildPathologySample } from "./sample.js";
import type { Event } from "../../domain/event.js";
import {
  decisionEvent,
  decisionState,
  effectLifecycleEvent,
} from "./persist.js";
import type { PathologyDecision } from "./types.js";

describe("checkpoint path classification", () => {
  it.each([
    [["src/a.test.ts"], "test_only"],
    [["src/a.spec.ts"], "test_only"],
    [["src/__tests__/a.ts"], "test_only"],
    [["src\\tests\\a.ts"], "test_only"],
    [["docs/note.md", "test/a.ts"], "test_only"],
    [["docs/note.md"], "metadata_only"],
    [["src/contest/parser.ts"], "production"],
    [["fixtures/case.json"], "production"],
    [["src/a.ts", "src/a.test.ts"], "production"],
    [[], "unknown"],
  ] as const)("classifies %j as %s", (paths, classification) => {
    expect(classifyCheckpointPaths(paths)).toMatchObject({ classification });
  });
});

describe("test-only verification treadmill", () => {
  it.each([3, 4])("detects a knob-sized window of %i distinct linked checkpoints", (windowSize) => {
    const sample = treadmillSample(windowSize);
    const finding = detectTestOnlyTreadmill([sample], windowSize);
    expect(finding).toEqual({
      kind: "test_only_verification_treadmill",
      sampleKeys: ["run:boundary"],
      evidenceRefs: Array.from({ length: windowSize }, (_, index) => [
        `event-${index}`,
        `task-${index}`,
        `finding-${index}`,
      ]).flat(),
      reason: `${String(windowSize)} validated blocking fixes changed tests only`,
    });
    const all = runDetectors({
      samples: [sample],
      knobs: { ...defaultConfig().convergence, testOnlyCheckpointWindow: windowSize },
      doneEligible: false,
    });
    expect(all[0]?.kind).toBe("test_only_verification_treadmill");
    const decision = selectStrategy({
      findings: all,
      ensembleChangesByPathology: Object.fromEntries(
        defaultConfigPathologies().map((kind) => [kind, 0]),
      ) as Record<ReturnType<typeof defaultConfigPathologies>[number], number>,
      maxEnsembleChangesPerPathology: 1,
      eligibleEnsemble: [{ provider: "p", model: "m" }],
      current: null,
      priorCheckpoints: [],
      nextReviewRoundIndex: 2,
    });
    expect(decision.action).toBe("NEEDS_HUMAN");
    expect(decision.targetEnsemble).toBeNull();
  });

  it("accepts RESOLVED as the current linked blocking status", () => {
    const sample = treadmillSample(3);
    for (const finding of sample.findingObservations) finding.status = "RESOLVED";
    expect(detectTestOnlyTreadmill([sample], 3)?.kind).toBe(
      "test_only_verification_treadmill",
    );
  });

  it.each([
    ["production change", (sample: PathologySample) => { sample.checkpointChanges![1]!.classification = "production"; }],
    ["metadata-only change", (sample: PathologySample) => { sample.checkpointChanges![1]!.classification = "metadata_only"; }],
    ["unknown change", (sample: PathologySample) => { sample.checkpointChanges![1]!.classification = "unknown"; }],
    ["mission origin", (sample: PathologySample) => { sample.taskWorkClasses[1]!.originKind = "mission_requirement"; }],
    ["investigation origin", (sample: PathologySample) => { sample.taskWorkClasses[1]!.originKind = "investigation"; }],
    ["missing link", (sample: PathologySample) => { sample.taskWorkClasses[1]!.originFindingId = null; }],
    ["nonblocking finding", (sample: PathologySample) => { sample.findingObservations[1]!.blocking = false; }],
    ["raw finding", (sample: PathologySample) => { sample.findingObservations[1]!.status = "RAW"; }],
    ["duplicate checkpoint", (sample: PathologySample) => { sample.checkpointChanges![1]!.headHash = sample.checkpointChanges![0]!.headHash; }],
  ])("does not detect with %s", (_name, mutate) => {
    const sample = treadmillSample(3);
    mutate(sample);
    expect(detectTestOnlyTreadmill([sample], 3)).toBeNull();
  });

  it("keeps historical v1 samples inert", () => {
    const sample = treadmillSample(3);
    sample.version = 1;
    delete sample.checkpointChanges;
    expect(detectTestOnlyTreadmill([sample], 3)).toBeNull();
  });

  it("uses the latest finding status by event seq", () => {
    const sample = treadmillSample(3);
    sample.findingObservations.push({
      ...sample.findingObservations[1]!,
      status: "REJECTED",
      seq: 99,
      causalEventId: "finding-rejected",
    });
    expect(detectTestOnlyTreadmill([sample], 3)).toBeNull();
  });

  it("persists the treadmill NEEDS_HUMAN lifecycle through the generic idempotent state", () => {
    const decision: PathologyDecision = {
      version: 1,
      runId: "run",
      boundaryEventId: "boundary",
      decisionVersion: 1,
      findings: [{
        kind: "test_only_verification_treadmill",
        sampleKeys: ["run:boundary"],
        evidenceRefs: ["event-1", "task-1", "finding-1"],
        reason: "tests only",
      }],
      action: "NEEDS_HUMAN",
      reason: "tests only",
      budget: treadmillSample(3).budget,
      targetCheckpointHash: null,
      targetEnsemble: null,
      targetReviewRoundIndex: null,
      causalEventIds: ["event-1", "task-1", "finding-1"],
    };
    const decided = asEvent(decisionEvent(decision, 10, []), 1);
    const started = asEvent(effectLifecycleEvent("pathology.effect_started", decision, 11, [decided.id]), 2);
    const completed = asEvent(effectLifecycleEvent("pathology.effect_completed", decision, 12, [started.id]), 3);
    expect(decisionState([decided], "run", "boundary")).toBe("decided");
    expect(decisionState([decided, started], "run", "boundary")).toBe("effect_started");
    expect(decisionState([decided, started, completed], "run", "boundary")).toBe("effect_completed");
  });

  it("builds v2 id/seq/origin/change links from the event prefix", () => {
    const taskId = "task-linked";
    const findingId = "finding-linked";
    const events: Event[] = [
      event(1, "run.created", {
        run: { createdAt: 1, missionId: "mission", currentCheckpointHash: null },
      }),
      event(2, "task.created", {
        task: {
          id: taskId,
          state: "INTEGRATED",
          kind: "bugfix",
          origin: { kind: "valid_finding", findingId },
        },
      }),
      event(3, "finding.raised", {
        finding: {
          id: findingId,
          fingerprint: "fp-linked",
          status: "VALID",
          blocking: true,
          severity: "high",
          checkpointHash: "a".repeat(40),
        },
      }),
      event(4, "checkpoint.created", {
        change: {
          taskId,
          parentHash: "a".repeat(40),
          headHash: "b".repeat(40),
          paths: ["src/a.test.ts"],
          classification: "test_only",
          causalEventId: "event-4",
        },
      }),
    ];
    const sample = buildPathologySample({
      events,
      boundary: events[3]!,
      config: defaultConfig(),
    });
    expect(sample.version).toBe(2);
    expect(sample.findingObservations).toEqual([expect.objectContaining({
      findingId,
      status: "VALID",
      seq: 3,
    })]);
    expect(sample.taskWorkClasses).toEqual([expect.objectContaining({
      taskId,
      originKind: "valid_finding",
      originFindingId: findingId,
    })]);
    expect(sample.checkpointChanges).toEqual([expect.objectContaining({
      taskId,
      classification: "test_only",
      causalEventId: "event-4",
    })]);
  });
});

function treadmillSample(size: number): PathologySample {
  return {
    version: 2,
    runId: "run",
    boundaryEventId: "boundary",
    boundarySeq: 100,
    observedAt: 100,
    checkpointHash: "f".repeat(40),
    findingObservations: Array.from({ length: size }, (_, index) => ({
      findingId: `finding-${index}`,
      fingerprint: `fp-${index}`,
      status: "VALID" as const,
      blocking: true,
      severity: "high" as const,
      checkpointHash: `${index}`.repeat(40),
      causalEventId: `finding-event-${index}`,
      seq: index + 1,
    })),
    progress: {
      checkpointHash: "f".repeat(40),
      evidence: null,
      integratedTaskIds: [],
      resolvedValidBlockingFingerprints: [],
      successfulGateFingerprints: [],
      acceptedEvidenceRefs: [],
      cleanRoundKeys: [],
    },
    disagreementRounds: [],
    taskIds: Array.from({ length: size }, (_, index) => `task-${index}`),
    taskWorkClasses: Array.from({ length: size }, (_, index) => ({
      taskId: `task-${index}`,
      workClass: "functional" as const,
      classifiedBy: null,
      sourceRef: null,
      classificationEventId: null,
      kind: "bugfix",
      originKind: "valid_finding",
      originFindingId: `finding-${index}`,
    })),
    checkpointChanges: Array.from({ length: size }, (_, index) => ({
      taskId: `task-${index}`,
      parentHash: `${index}`.repeat(40),
      headHash: `${index + 1}`.repeat(40),
      paths: [`src/a-${index}.test.ts`],
      classification: "test_only" as const,
      causalEventId: `event-${index}`,
    })),
    budget: {
      runTokens: 0,
      knownRunUsd: 0,
      unknownCostCalls: [],
      perTask: {},
      perRole: {},
      sourceWatermark: null,
      usageConflict: false,
      elapsedMs: 0,
      limits: {
        maxRunTokens: null,
        maxRunUsd: null,
        maxTaskTokens: null,
        maxRunWallClockMinutes: null,
      },
      unusedCliMetadata: { budgetTokens: null, budgetUsd: null, applied: false },
      exhaustedDimensions: [],
    },
  };
}

function defaultConfigPathologies() {
  return [
    "finding_oscillation",
    "checkpoint_oscillation",
    "test_only_verification_treadmill",
    "no_progress",
    "disagreement_not_shrinking",
    "task_graph_growth_from_nonblocking",
  ] as const;
}

function event(seq: number, type: Event["type"], payload: Record<string, unknown>): Event {
  return {
    schemaVersion: 1,
    id: `event-${seq}`,
    runId: "run",
    seq,
    ts: seq,
    type,
    payload,
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  };
}

function asEvent(value: Omit<Event, "seq" | "schemaVersion">, seq: number): Event {
  return { ...value, schemaVersion: 1, seq };
}
