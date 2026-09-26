import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig } from "../domain/config.js";
import { CORPUS_EXECUTABLE_STATUS } from "../domain/acceptance.js";
import { findingFingerprint, type Finding } from "../domain/finding.js";
import { ScriptedFindingEvidenceWorker, type EvidenceAttempt } from "../findings/index.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { eventsThroughBoundary, resolveObservationBoundary } from "../convergence/pathology/index.js";
import { RunEngine } from "./engine.js";
import { createValidatingDriver } from "./reviewDrivers.js";
import { stubDriverFor } from "./stubs.js";

const NOW = 1_700_000_000_000;
const SHA = "b".repeat(64);
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("B5 production VALIDATING driver", () => {
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;
  let fixture: Fixture;

  beforeEach(() => {
    fixture = repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "REVIEWING", "CONVERGENCE_CHECK"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase(
      "VALIDATING",
      createValidatingDriver({
        resolveWorker: () =>
          new ScriptedFindingEvidenceWorker(() => ({
            method: "deterministic_reproduction",
            verdict: "VALID",
            rationale: "reproduced with scripted worker",
            evidenceRefs: [{ sha256: SHA, kind: "test_output", bytes: 12 }],
            outcome: "demonstrated",
            performedBy: { kind: "system" },
          })),
      }),
    );
  });

  afterEach(() => {
    store.close();
  });

  it("VALID blocking finding creates a coding task with valid_finding origin and corpus entry", async () => {
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("PLANNING");
    const tasks = store.repos.tasks.listByRun(runId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.origin).toMatchObject({ kind: "valid_finding", verdict: "VALID" });
    expect(tasks[0]?.touchesProductCode).toBe(true);
    const corpus = store.repos.acceptanceCorpus.forMission(run.missionId);
    expect(corpus.entries).toHaveLength(1);
    expect(corpus.entries[0]?.artifactHashes).toEqual([SHA]);
    expect(corpus.entries[0]?.metadata["executableStatus"])
      .toBe(CORPUS_EXECUTABLE_STATUS.pendingIntegration);
    expect(store.events.list(runId, { types: ["acceptance.recorded"] })).toEqual([]);
    expect(store.events.list(runId, { types: ["finding.validated"] })).toHaveLength(1);
  });

  it("records a validated finding's history through VALIDATING, one step per event", async () => {
    const finding = blockingFinding(fixture.integrated);
    const { runId } = seedValidatingRun(store, clock, fixture, [finding]);
    await engine.tickRun(runId);

    const steps = store.events
      .list(runId, { types: ["finding.status_changed"] })
      .filter((event) => (event.payload["finding"] as Finding).id === finding.id)
      .map((event) => [event.payload["from"], event.payload["to"]]);
    expect(steps).toEqual([["RAW", "VALIDATING"], ["VALIDATING", "VALID"]]);
  });

  it("does not treat a missing reviewer as a canary pass", async () => {
    const config = defaultConfig();
    config.review.reviewersPerRound = 1;
    config.review.maxCanaryRotations = 0;
    const local = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    local.registerPhase("VALIDATING", createValidatingDriver({
      resolveWorker: () => new ScriptedFindingEvidenceWorker(() => validAttempt()),
      resolveReviewers: () => [],
    }));
    const { runId, checkpointHash } = seedValidatingRun(store, clock, fixture, []);
    const execution = {
      id: id("evt", clock.now() + 40),
      runId,
      checkpointHash,
      roundIndex: 1,
      axis: "correctness" as const,
      requestedModel: { provider: "models", model: "m0" },
      completed: true,
      findings: [],
      promptDigest: "digest",
      startedAt: clock.now(),
      finishedAt: clock.now(),
    };
    store.events.append([{
      id: id("evt", clock.now() + 50),
      runId,
      ts: clock.now() + 50,
      type: "review.finished",
      payload: { execution },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
    await local.tickRun(runId);
    const run = store.repos.runs.get(runId);
    expect(run?.phase).toBe("NEEDS_HUMAN");
    expect(run?.terminalReason?.code).toBe("review_unverifiable");
    const canary = store.events.list(runId, { types: ["review.canary_recorded"] })[0];
    expect(canary?.payload).toMatchObject({ verified: false, error: "reviewer no longer selectable" });
  });

  it("does not record a round clean when one family answered two of its axes", async () => {
    const config = defaultConfig();
    config.review.reviewersPerRound = 2;
    const local = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const reviewer = (model: string, family: string) => ({
      provider: {
        id: "models",
        kind: "scripted",
        concurrency: null,
        listModels: () => Promise.resolve([]),
        health: () => Promise.resolve({ ok: true, checkedAt: NOW }),
        complete: () => Promise.reject(new Error("must not be called")),
      },
      model: { provider: "models", model },
      family,
    });
    local.registerPhase("VALIDATING", createValidatingDriver({
      resolveWorker: () => new ScriptedFindingEvidenceWorker(() => validAttempt()),
      resolveReviewers: () => [reviewer("a-large", "a"), reviewer("a-small", "a"), reviewer("b-1", "b")],
    }));
    const { runId, checkpointHash } = seedValidatingRun(store, clock, fixture, []);
    const axes = [["correctness", "a-large"], ["security", "a-small"]] as const;
    store.events.append(axes.map(([axis, model], index) => ({
      id: id("evt", clock.now() + 40 + index),
      runId,
      ts: clock.now() + 40 + index,
      type: "review.finished" as const,
      payload: {
        execution: {
          id: id("evt", clock.now() + 60 + index),
          runId,
          checkpointHash,
          roundIndex: 1,
          axis,
          requestedModel: { provider: "models", model },
          completed: true,
          findings: [],
          promptDigest: "digest",
          startedAt: clock.now(),
          finishedAt: clock.now(),
        },
      },
      causedBy: [],
      actor: { kind: "system" as const },
      artifacts: [],
    })));
    await local.tickRun(runId);
    const run = store.repos.runs.get(runId);
    expect(run?.phase).toBe("NEEDS_HUMAN");
    expect(run?.terminalReason?.code).toBe("review_unverifiable");
    expect(run?.terminalReason?.summary).toContain("insufficient_families: 1 of 2 (a)");
    expect(store.repos.cleanRounds.listByRun(runId)).toHaveLength(0);
    expect(store.events.list(runId, { types: ["review.canary_recorded"] })).toHaveLength(0);
  });

  it("dedupes duplicate fingerprints without evidence work", async () => {
    const finding = blockingFinding(fixture.integrated);
    const existing = { ...finding, id: id("find", NOW + 1), status: "VALID" as const };
    const { runId } = seedValidatingRun(store, clock, fixture, [finding], [existing]);
    let calls = 0;
    engine.registerPhase(
      "VALIDATING",
      createValidatingDriver({
        resolveWorker: () =>
          new ScriptedFindingEvidenceWorker(() => {
            calls++;
            return validAttempt();
          }),
      }),
    );
    await engine.tickRun(runId);

    expect(calls).toBe(0);
    const updated = store.repos.findings.get(finding.id)!;
    expect(updated.status).toBe("DUPLICATE");
    expect(updated.duplicateOf).toBe(existing.id);
    expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
  });

  it("UNCERTAIN spawns investigation task only and advances to PLANNING", async () => {
    engine.registerPhase(
      "VALIDATING",
      createValidatingDriver({
        resolveWorker: () => new ScriptedFindingEvidenceWorker(() => uncertainAttempt()),
      }),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);

    const tasks = store.repos.tasks.listByRun(runId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "investigation", touchesProductCode: false });
    expect(store.repos.acceptanceCorpus.forMission(store.repos.runs.get(runId)!.missionId).entries).toHaveLength(0);
    expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
  });

  it("REJECTED creates no tasks and goes to CONVERGENCE_CHECK", async () => {
    engine.registerPhase(
      "VALIDATING",
      createValidatingDriver({
        resolveWorker: () => new ScriptedFindingEvidenceWorker(() => rejectedAttempt()),
      }),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);

    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("REJECTED");
    expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
  });

  it("notes opinion-only findings as NOTED without validation events", async () => {
    const opinion = blockingFinding(fixture.integrated, {
      evidence: [],
      reproduction: [],
      suggestedCheck: undefined,
      blocking: false,
    });
    const { runId } = seedValidatingRun(store, clock, fixture, [opinion]);
    await engine.tickRun(runId);

    expect(store.repos.findings.get(opinion.id)?.status).toBe("NOTED");
    expect(store.events.list(runId, { types: ["finding.validated"] })).toHaveLength(0);
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
    expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
  });

  it("keeps one survivor when two RAW findings share a fingerprint", async () => {
    const first = blockingFinding(fixture.integrated);
    const second = {
      ...first,
      id: id("find", NOW + 2),
      createdAt: NOW + 2,
      updatedAt: NOW + 2,
    };
    let calls = 0;
    engine.registerPhase(
      "VALIDATING",
      createValidatingDriver({
        resolveWorker: () =>
          new ScriptedFindingEvidenceWorker(() => {
            calls++;
            return validAttempt();
          }),
      }),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [first, second]);
    await engine.tickRun(runId);

    expect(calls).toBe(1);
    expect(store.repos.findings.get(first.id)?.status).toBe("VALID");
    expect(store.repos.findings.get(second.id)?.status).toBe("DUPLICATE");
    expect(store.repos.findings.get(second.id)?.duplicateOf).toBe(first.id);
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(1);
    expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
  });

  it("does not return to PLANNING when prior finding tasks are no longer pending", async () => {
    const finding = { ...blockingFinding(fixture.integrated), status: "VALID" as const };
    const { runId } = seedValidatingRun(store, clock, fixture, [], [finding]);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
  });

  it("CONVERGENCE_CHECK sample after one evidence-agent validation includes that validation", async () => {
    engine.registerPhase(
      "VALIDATING",
      createValidatingDriver({
        resolveWorker: () => new ScriptedFindingEvidenceWorker(() => rejectedAttempt()),
      }),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
    expect(store.events.list(runId, { types: ["finding.validated"] })).toHaveLength(1);
    const events = store.events.list(runId);
    const boundary = resolveObservationBoundary(events, defaultConfig().review.reviewersPerRound);
    expect(boundary).not.toBeNull();
    const prefix = eventsThroughBoundary(events, boundary!.id);
    expect(prefix.some((event) => event.type === "finding.validated")).toBe(true);
  });
});

interface Fixture {
  root: string;
  repoDir: string;
  base: string;
  integrated: string;
}

function repositoryFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "polish-b5-validate-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-b5-fixture" }));
  writeFileSync(join(repoDir, "alpha.ts"), "export const a = 1;\n");
  const base = "a".repeat(40);
  const integrated = "b".repeat(40);
  return { root, repoDir, base, integrated };
}

function blockingFinding(checkpointHash: string, overrides: Partial<Finding> = {}): Finding {
  const raw = {
    criterion: "auth.persistence",
    severity: "high" as const,
    blocking: true,
    claim: "logout leaves refresh token behind",
    evidence: [{ path: "src/auth/store.ts", line: 81 }],
    reproduction: ["pnpm test auth"],
    suggestedCheck: "regression test proves logout clears the token",
  };
  return {
    id: id("find", NOW),
    runId: id("run", NOW),
    checkpointHash,
    axis: "correctness",
    reportedBy: { kind: "reviewer" },
    status: "RAW",
    duplicateOf: null,
    fingerprint: findingFingerprint(raw),
    investigationRounds: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...raw,
    ...overrides,
  };
}

function seedValidatingRun(
  store: Store,
  clock: FakeClock,
  fixture: Fixture,
  findings: Finding[],
  existing: Finding[] = [],
): { runId: string; checkpointHash: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  for (const finding of findings) finding.runId = runId;
  for (const finding of existing) finding.runId = runId;

  const baseline: BaselineSnapshot = {
    id: id("base", clock.now()),
    runId,
    commitHash: fixture.base,
    checks: [],
    configHashes: {},
    scriptsHash: "0".repeat(64),
    toolchain: {},
    createdAt: clock.now(),
  };
  const checkpoint: Checkpoint = {
    id: id("cp", clock.now()),
    runId,
    seq: 1,
    commitHash: fixture.integrated,
    parentId: null,
    source: "integration",
    taskId: id("task", clock.now()),
    evidence: {
      gates: { gate: "pass" },
      testsPassed: 1,
      testsFailed: 0,
      testsTotal: 1,
      openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      diffLinesFromBaseline: 2,
    },
    createdAt: clock.now(),
  };
  const run = {
    id: runId,
    missionId,
    projectPath: fixture.repoDir,
    runBranch: "run",
    phase: "VALIDATING" as const,
    control: "RUNNING" as const,
    currentCheckpointHash: fixture.integrated,
    baselineId: baseline.id,
    interpretationId: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    terminalReason: null,
  };
  const events = [
    { id: id("evt", clock.now()), runId, ts: clock.now(), type: "run.created" as const, payload: { run }, causedBy: [] as string[], actor: { kind: "system" as const }, artifacts: [] },
    { id: id("evt", clock.now() + 1), runId, ts: clock.now() + 1, type: "baseline.snapshotted" as const, payload: { baseline }, causedBy: [] as string[], actor: { kind: "system" as const }, artifacts: [] },
    { id: id("evt", clock.now() + 2), runId, ts: clock.now() + 2, type: "checkpoint.created" as const, payload: { checkpoint }, causedBy: [] as string[], actor: { kind: "system" as const }, artifacts: [] },
    ...existing.map((finding, index) => ({
      id: id("evt", clock.now() + 10 + index),
      runId,
      ts: clock.now() + 10 + index,
      type: "finding.raised" as const,
      payload: { finding },
      causedBy: [] as string[],
      actor: { kind: "reviewer" as const },
      artifacts: [],
    })),
    ...findings.map((finding, index) => ({
      id: id("evt", clock.now() + 20 + index),
      runId,
      ts: clock.now() + 20 + index,
      type: "finding.raised" as const,
      payload: { finding },
      causedBy: [] as string[],
      actor: { kind: "reviewer" as const },
      artifacts: [],
    })),
  ];
  store.events.append(events);
  return { runId, checkpointHash: fixture.integrated };
}

function validAttempt(): EvidenceAttempt {
  return {
    method: "deterministic_reproduction",
    verdict: "VALID",
    rationale: "reproduced",
    evidenceRefs: [{ sha256: SHA, kind: "test_output", bytes: 12 }],
    outcome: "demonstrated",
    performedBy: { kind: "system" },
  };
}

function uncertainAttempt(): EvidenceAttempt {
  return {
    method: "investigation",
    verdict: "UNCERTAIN",
    rationale: "could not reproduce deterministically",
    evidenceRefs: [],
  };
}

function rejectedAttempt(): EvidenceAttempt {
  return {
    method: "deterministic_reproduction",
    verdict: "REJECTED",
    rationale: "defect not reproduced",
    evidenceRefs: [],
  };
}
