import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig } from "../domain/config.js";
import { findingFingerprint, type Finding, type FindingValidation } from "../domain/finding.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { ScriptedFindingEvidenceWorker, type DebateRoles, type EvidenceAttempt } from "../findings/index.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { MissionAcceptanceService, openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { RunEngine } from "./engine.js";
import { createConvergenceDriver } from "./convergenceDrivers.js";
import { createValidatingDriver, type DebateCompletionRequest } from "./reviewDrivers.js";
import { stubDriverFor } from "./stubs.js";

const NOW = 1_700_000_000_000;
const SHA = "b".repeat(64);
const ROLES: DebateRoles = {
  prosecutor: { provider: "scripted", model: "prosecutor" },
  defender: { provider: "scripted", model: "defender" },
  judge: { provider: "scripted", model: "judge" },
};
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("C4 finding debate in createValidatingDriver", () => {
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;
  let fixture: Fixture;
  let calls: DebateCompletionRequest[];

  beforeEach(() => {
    fixture = repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "REVIEWING", "CONVERGENCE_CHECK"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    calls = [];
    activeCalls = calls;
  });

  afterEach(() => {
    store.close();
  });

  it("1. refuses non-UNCERTAIN findings and makes no provider calls", async () => {
    engine.registerPhase("VALIDATING", debateDriver(() => validAttempt(), recorder(() => "should not run"), ROLES));
    const finding = { ...blockingFinding(fixture.integrated), status: "VALID" as const };
    const { runId } = seedValidatingRun(store, clock, fixture, [], [finding]);
    await engine.tickRun(runId);
    expect(calls).toHaveLength(0);
    expect(store.events.list(runId, { types: ["finding.debate_started"] })).toHaveLength(0);
  });

  it("2. scripted VALID with pre-debate evidence creates one coding task and honest corpus", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainWithEvidence(), recorder(judgeScript("VALID")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);

    const finding = store.repos.findings.listByRun(runId)[0]!;
    expect(finding.status).toBe("VALID");
    const tasks = store.repos.tasks.listByRun(runId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.origin).toMatchObject({ kind: "valid_finding", verdict: "VALID" });
    const validations = store.repos.validations.listByFinding(finding.id);
    expect(validations.some((item) => item.method === "investigation" || item.method === "failing_test" || item.verdict === "UNCERTAIN")).toBe(true);
    const debate = validations.find((item) => item.method === "finding_debate");
    expect(debate?.verdict).toBe("VALID");
    expect(debate?.evidenceRefs.some((ref) => ref.sha256 === SHA)).toBe(true);
    const corpus = store.repos.acceptanceCorpus.forMission(store.repos.runs.get(runId)!.missionId);
    expect(corpus.entries).toHaveLength(1);
    expect(corpus.entries[0]?.kind).toBe("regression_test");
    expect(corpus.entries[0]?.artifactHashes).toEqual([SHA]);
    assertDebateBeforeTask(store, runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
  });

  it("2b. debate VALID non-blocking registers corpus and creates no coding task", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainWithEvidence(), recorder(judgeScript("VALID")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated, { blocking: false })]);
    await engine.tickRun(runId);
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("VALID");
    expect(store.repos.acceptanceCorpus.forMission(store.repos.runs.get(runId)!.missionId).entries).toHaveLength(1);
  });

  it("3. scripted VALID without pre-debate evidence fails closed", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainAttempt(), recorder(judgeScript("VALID")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    const finding = store.repos.findings.listByRun(runId)[0]!;
    expect(finding.status).toBe("UNCERTAIN");
    expect(store.repos.tasks.listByRun(runId).every((task) => task.kind === "investigation")).toBe(true);
    expect(store.repos.tasks.listByRun(runId).some((task) => task.origin.kind === "valid_finding")).toBe(false);
    expect(store.repos.validations.listByFinding(finding.id).find((item) => item.method === "finding_debate")?.verdict).toBe(
      "UNCERTAIN",
    );
  });

  it("4. scripted REJECTED leaves zero tasks", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainWithEvidence(), recorder(judgeScript("REJECTED")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("REJECTED");
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
    expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
  });

  it("5. all-UNCERTAIN rounds spawn investigation and increment investigationRounds", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainAttempt(), recorder(judgeScript("UNCERTAIN")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    const finding = store.repos.findings.listByRun(runId)[0]!;
    expect(finding.status).toBe("UNCERTAIN");
    expect(finding.investigationRounds).toBe(1);
    const tasks = store.repos.tasks.listByRun(runId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "investigation", touchesProductCode: false });
    expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
  });

  it.each([0, 2])("5b. an UNCERTAIN non-blocking finding stays advisory (investigationRounds %i)", async (investigationRounds) => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainAttempt(), recorder(judgeScript("UNCERTAIN")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [
      blockingFinding(fixture.integrated, { blocking: false, severity: "medium", investigationRounds }),
    ]);
    await engine.tickRun(runId);
    const finding = store.repos.findings.listByRun(runId)[0]!;
    expect(finding.status).toBe("UNCERTAIN");
    expect(finding.investigationRounds).toBe(investigationRounds);
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
    expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
  });

  it("5c. without debate roles an UNCERTAIN non-blocking finding still stays advisory", async () => {
    engine.registerPhase("VALIDATING", debateDriver(() => uncertainAttempt(), recorder(judgeScript("UNCERTAIN")), null));
    const { runId } = seedValidatingRun(store, clock, fixture, [
      blockingFinding(fixture.integrated, { blocking: false, severity: "medium", investigationRounds: 2 }),
    ]);
    await engine.tickRun(runId);
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
    expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
  });

  it("6. exhausted residual UNCERTAIN becomes NEEDS_HUMAN with no coding task or DONE", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainAttempt(), recorder(judgeScript("UNCERTAIN")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [
      blockingFinding(fixture.integrated, { investigationRounds: 2 }),
    ]);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("NEEDS_HUMAN");
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("UNCERTAIN");
  });

  it("7. malformed judge / empty advocate / throw do not upgrade to VALID", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainAttempt(),
        recorder((request) => {
          if (request.role === "prosecutor") return "";
          return judgeScript("VALID")(request);
        }),
        ROLES,
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [
      blockingFinding(fixture.integrated, { investigationRounds: 2 }),
    ]);
    await engine.tickRun(runId);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("UNCERTAIN");
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
    expect(store.repos.runs.get(runId)?.phase).toBe("NEEDS_HUMAN");
  });

  it("7b. malformed judge JSON does not upgrade to VALID", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainWithEvidence(),
        recorder((request) => (request.role === "judge" ? "not-json" : `${request.role} argument`)),
        ROLES,
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("UNCERTAIN");
    expect(store.repos.tasks.listByRun(runId).some((task) => task.origin.kind === "valid_finding")).toBe(false);
  });

  it("7d. an unreadable judge verdict is asked again before anything is called UNCERTAIN", async () => {
    let judged = 0;
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainWithEvidence(),
        recorder((request) => {
          if (request.role !== "judge") return `${request.role} argument`;
          judged += 1;
          return judged === 1 ? "not-json" : judgeScript("REJECTED")(request);
        }),
        ROLES,
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(judged).toBe(2);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("REJECTED");
    const outcome = store.events.list(runId, { types: ["finding.debate_outcome"] })[0];
    expect(outcome?.payload).toMatchObject({ verdict: "REJECTED", hardFailure: false });
  });

  it("7e. a judge of another family decides when the seated judge cannot, and is the one recorded", async () => {
    const alternate = { provider: "scripted", model: "alternate-judge" };
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainWithEvidence(),
        recorder((request) => {
          if (request.role !== "judge") return `${request.role} argument`;
          if (request.model.model === "judge") throw new Error("judge timed out");
          return judgeScript("REJECTED")(request);
        }),
        { ...ROLES, judgeAlternates: [alternate] },
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    const judgeCalls = calls.filter((call) => call.role === "judge").map((call) => call.model.model);
    expect(judgeCalls).toEqual(["judge", "judge", "alternate-judge"]);
    const finding = store.repos.findings.listByRun(runId)[0];
    expect(finding?.status).toBe("REJECTED");
    const validation = store.repos.validations.listByFinding(finding!.id).at(-1);
    expect(JSON.stringify(validation)).toContain("alternate-judge");
  });

  it("7f. UNCERTAIN names every judge that failed when none could answer", async () => {
    const alternate = { provider: "scripted", model: "alternate-judge" };
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainWithEvidence(),
        recorder((request) => (request.role === "judge" ? "not-json" : `${request.role} argument`)),
        { ...ROLES, judgeAlternates: [alternate] },
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(calls.filter((call) => call.role === "judge")).toHaveLength(3);
    const outcome = store.events.list(runId, { types: ["finding.debate_outcome"] })[0];
    expect(outcome?.payload["verdict"]).toBe("UNCERTAIN");
    expect(String(outcome?.payload["rationale"])).toContain("scripted:alternate-judge: unreadable verdict");
  });

  it("7g. judges that only answer unreadably end the debate once, keeping the last judge's words", async () => {
    const alternate = { provider: "scripted", model: "alternate-judge" };
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainWithEvidence(),
        recorder((request) => (request.role === "judge" ? `unreadable from ${request.model.model}` : `${request.role} argument`)),
        { ...ROLES, judgeAlternates: [alternate] },
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(calls.filter((call) => call.role === "judge")).toHaveLength(3);
    expect(store.events.list(runId, { types: ["finding.debate_outcome"] })).toHaveLength(1);
    const judgeArguments = store.events
      .list(runId, { types: ["finding.debate_argument"] })
      .filter((event) => event.payload["role"] === "judge");
    expect(judgeArguments).toHaveLength(1);
    expect(judgeArguments[0]?.payload["text"]).toBe("unreadable from alternate-judge");
    expect(judgeArguments[0]?.actor).toMatchObject({ role: "judge", model: alternate });
  });

  it("7h. a judge that never answers ends the debate once, with no judge argument on record", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainWithEvidence(),
        recorder((request) => {
          if (request.role === "judge") throw new Error("judge timed out");
          return `${request.role} argument`;
        }),
        ROLES,
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(calls.filter((call) => call.role === "judge")).toHaveLength(2);
    const outcomes = store.events.list(runId, { types: ["finding.debate_outcome"] });
    expect(outcomes).toHaveLength(1);
    expect(String(outcomes[0]?.payload["rationale"])).toContain("from every judge asked");
    const judgeArguments = store.events
      .list(runId, { types: ["finding.debate_argument"] })
      .filter((event) => event.payload["role"] === "judge");
    expect(judgeArguments).toEqual([]);
  });

  it("7i. a thrown advocate ends the debate without asking any judge", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainWithEvidence(),
        recorder((request) => {
          if (request.role === "prosecutor") throw new Error("advocate crashed");
          return judgeScript("VALID")(request);
        }),
        ROLES,
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(calls.map((call) => call.role)).toEqual(["prosecutor"]);
    const outcomes = store.events.list(runId, { types: ["finding.debate_outcome"] });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload["rationale"]).toBe("debate role prosecutor failed: advocate crashed");
  });

  it("7j. a debate that stopped before any judge spoke is recorded against the seated judge", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(
        () => uncertainWithEvidence(),
        recorder((request) => (request.role === "defender" ? "" : judgeScript("VALID")(request))),
        ROLES,
      ),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    const finding = store.repos.findings.listByRun(runId)[0]!;
    const debate = store.repos.validations.listByFinding(finding.id).find((item) => item.method === "finding_debate");
    expect(debate?.verdict).toBe("UNCERTAIN");
    expect(debate?.performedBy).toEqual({ kind: "judge", role: "judge", model: ROLES.judge });
  });

  it("7c. thrown advocate does not upgrade to VALID", async () => {
    engine.registerPhase(
      "VALIDATING",
      createValidatingDriver({
        resolveWorker: () => new ScriptedFindingEvidenceWorker(() => uncertainAttempt()),
        resolveDebateRoles: () => ROLES,
        completeDebate: async (_ctx, request) => {
          calls.push(request);
          if (request.role === "prosecutor") throw new Error("advocate crashed");
          return judgeScript("VALID")(request);
        },
      }),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("UNCERTAIN");
    expect(store.repos.tasks.listByRun(runId).some((task) => task.origin.kind === "valid_finding")).toBe(false);
  });

  it("8. fewer than three distinct models skips debate and does not invent a verdict", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainAttempt(), recorder(() => "should not run"), null),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    expect(calls).toHaveLength(0);
    expect(store.events.list(runId, { types: ["finding.debate_started"] })).toHaveLength(0);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("UNCERTAIN");
    expect(store.repos.tasks.listByRun(runId)[0]?.kind).toBe("investigation");
  });

  it("9. resume after debate_started completes missing roles once and never strands VALIDATING", async () => {
    const { runId, finding } = seedUncertainPrefix(store, clock, fixture, { evidence: true });
    persistStarted(store, clock, finding, ROLES);
    persistArgument(store, clock, finding, "prosecutor", 1, "already argued");
    engine.registerPhase("VALIDATING", debateDriver(() => uncertainWithEvidence(), recorder(judgeScript("REJECTED")), ROLES));
    await engine.tickRun(runId);
    expect(calls.map((item) => item.role)).toEqual(["defender", "judge"]);
    expect(store.repos.findings.get(finding.id)?.status).toBe("REJECTED");
    expect(store.repos.findings.get(finding.id)?.status).not.toBe("VALIDATING");
    expect(store.events.list(runId, { types: ["finding.debate_started"] })).toHaveLength(1);
  });

  it("10. crash after outcome applies the effect once and does not start a second debate", async () => {
    const { runId, finding } = seedUncertainPrefix(store, clock, fixture, { evidence: true });
    persistStarted(store, clock, finding, ROLES);
    persistArgument(store, clock, finding, "prosecutor", 1, "p");
    persistArgument(store, clock, finding, "defender", 1, "d");
    persistArgument(store, clock, finding, "judge", 1, '{"verdict":"REJECTED","rationale":"not reproduced"}');
    persistOutcome(store, clock, finding, "REJECTED", "not reproduced");
    engine.registerPhase("VALIDATING", debateDriver(() => uncertainWithEvidence(), recorder(judgeScript("VALID")), ROLES));
    await engine.tickRun(runId);
    expect(calls).toHaveLength(0);
    expect(store.events.list(runId, { types: ["finding.debate_started"] })).toHaveLength(1);
    expect(store.events.list(runId, { types: ["finding.debate_outcome"] })).toHaveLength(1);
    expect(store.repos.findings.get(finding.id)?.status).toBe("REJECTED");
    expect(store.repos.validations.listByFinding(finding.id).filter((item) => item.method === "finding_debate")).toHaveLength(1);
  });

  it("11. replay of a persisted debate prefix does not re-call providers", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainWithEvidence(), recorder(judgeScript("REJECTED")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    const firstCalls = calls.length;
    expect(firstCalls).toBeGreaterThan(0);
    store.events.append([
      {
        id: id("evt", clock.now() + 500),
        runId,
        ts: clock.now() + 500,
        type: "run.phase_changed",
        payload: { run: { ...store.repos.runs.get(runId)!, phase: "VALIDATING", updatedAt: clock.now() + 500 } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
    await engine.tickRun(runId);
    expect(calls).toHaveLength(firstCalls);
  });

  it("12. investigation task.created is not persisted before debate_outcome", async () => {
    engine.registerPhase(
      "VALIDATING",
      debateDriver(() => uncertainAttempt(), recorder(judgeScript("UNCERTAIN")), ROLES),
    );
    const { runId } = seedValidatingRun(store, clock, fixture, [blockingFinding(fixture.integrated)]);
    await engine.tickRun(runId);
    const events = store.events.list(runId);
    const outcome = events.find((event) => event.type === "finding.debate_outcome");
    const investigation = events.find(
      (event) => event.type === "task.created" && (event.payload["task"] as { kind?: string }).kind === "investigation",
    );
    expect(outcome).toBeDefined();
    expect(investigation).toBeDefined();
    expect(outcome!.seq).toBeLessThan(investigation!.seq);
  });

  it("13. open debate at investigation exhaustion cannot yield CONVERGENCE_CHECK DONE", async () => {
    const { runId, finding } = seedConvergenceOpenDebate(store, clock, fixture);
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
    await engine.tickRun(runId);
    expect(store.repos.findings.get(finding.id)?.status).toBe("UNCERTAIN");
    expect(store.repos.runs.get(runId)?.phase).not.toBe("DONE");
    expect(store.repos.runs.get(runId)?.phase).toBe("NEEDS_HUMAN");
  });
});

interface Fixture {
  root: string;
  repoDir: string;
  base: string;
  integrated: string;
}

function repositoryFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "polish-c4-debate-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-c4-fixture" }));
  writeFileSync(join(repoDir, "alpha.ts"), "export const a = 1;\n");
  return { root, repoDir, base: "a".repeat(40), integrated: "b".repeat(40) };
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

function debateDriver(
  worker: () => EvidenceAttempt,
  complete: (request: DebateCompletionRequest) => string,
  roles: DebateRoles | null,
) {
  return createValidatingDriver({
    resolveWorker: () => new ScriptedFindingEvidenceWorker(worker),
    resolveDebateRoles: () => roles,
    completeDebate: async (_ctx, request) => complete(request),
  });
}

function recorder(complete: (request: DebateCompletionRequest) => string) {
  return (request: DebateCompletionRequest): string => {
    callsForRecorder().push(request);
    return complete(request);
  };
}

let activeCalls: DebateCompletionRequest[] | null = null;
function callsForRecorder(): DebateCompletionRequest[] {
  if (activeCalls === null) throw new Error("test calls buffer missing");
  return activeCalls;
}

function judgeScript(verdict: "VALID" | "REJECTED" | "UNCERTAIN") {
  return (request: DebateCompletionRequest): string => {
    if (request.role === "judge") return JSON.stringify({ verdict, rationale: `scripted ${verdict}` });
    return `${request.role} cites only supplied evidence`;
  };
}

function validAttempt(): EvidenceAttempt {
  return {
    method: "failing_test",
    verdict: "VALID",
    rationale: "reproduced",
    evidenceRefs: [{ sha256: SHA, kind: "test_output", bytes: 12 }],
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

function uncertainWithEvidence(): EvidenceAttempt {
  return {
    method: "failing_test",
    verdict: "UNCERTAIN",
    rationale: "flaky reproduction",
    evidenceRefs: [{ sha256: SHA, kind: "test_output", bytes: 12 }],
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
  appendRunSkeleton(store, clock, fixture, runId, missionId, "VALIDATING");
  store.events.append([
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
  ]);
  return { runId, checkpointHash: fixture.integrated };
}

function seedUncertainPrefix(
  store: Store,
  clock: FakeClock,
  fixture: Fixture,
  options: { evidence: boolean },
): { runId: string; finding: Finding } {
  const finding = blockingFinding(fixture.integrated, { status: "UNCERTAIN" });
  const { runId } = seedValidatingRun(store, clock, fixture, [], [finding]);
  const validation: FindingValidation = {
    id: id("fval", clock.now() + 30),
    findingId: finding.id,
    runId,
    method: options.evidence ? "failing_test" : "investigation",
    verdict: "UNCERTAIN",
    rationale: "b5 uncertain",
    evidenceRefs: options.evidence ? [{ sha256: SHA, kind: "test_output", bytes: 12 }] : [],
    performedBy: { kind: "evidence_agent" },
    createdAt: clock.now() + 30,
  };
  store.events.append([
    {
      id: id("evt", clock.now() + 31),
      runId,
      ts: clock.now() + 31,
      type: "finding.status_changed",
      payload: { finding, from: "RAW", to: "UNCERTAIN" },
      causedBy: [],
      actor: { kind: "evidence_agent" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 32),
      runId,
      ts: clock.now() + 32,
      type: "finding.validated",
      payload: { validation, finding },
      causedBy: [],
      actor: { kind: "evidence_agent" },
      artifacts: validation.evidenceRefs,
    },
  ]);
  return { runId, finding: { ...finding, runId } };
}

function persistStarted(store: Store, clock: FakeClock, finding: Finding, roles: DebateRoles): void {
  const causal = store.events.list(finding.runId, { types: ["finding.validated"] })[0]!.id;
  store.events.append([
    {
      id: id("evt", clock.now() + 40),
      runId: finding.runId,
      ts: clock.now() + 40,
      type: "finding.debate_started",
      payload: { findingId: finding.id, checkpointHash: finding.checkpointHash, roles, causalValidationId: causal },
      causedBy: [causal],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
}

function persistArgument(
  store: Store,
  clock: FakeClock,
  finding: Finding,
  role: "prosecutor" | "defender" | "judge",
  roundIndex: number,
  text: string,
): void {
  const artifact = store.artifacts.put(text, `debate.${role}`, `${finding.id}:${role}`, clock.now());
  store.events.append([
    {
      id: id("evt", clock.now() + 50 + roundIndex * 3 + ["prosecutor", "defender", "judge"].indexOf(role)),
      runId: finding.runId,
      ts: clock.now() + 50,
      type: "finding.debate_argument",
      payload: { findingId: finding.id, checkpointHash: finding.checkpointHash, role, roundIndex, text },
      causedBy: [],
      actor: { kind: role, role, model: ROLES[role] },
      artifacts: [artifact],
    },
  ]);
}

function persistOutcome(
  store: Store,
  clock: FakeClock,
  finding: Finding,
  verdict: "VALID" | "REJECTED" | "UNCERTAIN",
  rationale: string,
): void {
  store.events.append([
    {
      id: id("evt", clock.now() + 80),
      runId: finding.runId,
      ts: clock.now() + 80,
      type: "finding.debate_outcome",
      payload: {
        findingId: finding.id,
        checkpointHash: finding.checkpointHash,
        verdict,
        rationale,
        roundCount: 1,
        hardFailure: false,
        causalRefs: [],
      },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
}

function seedConvergenceOpenDebate(
  store: Store,
  clock: FakeClock,
  fixture: Fixture,
): { runId: string; finding: Finding } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const interpretationId = id("interp", clock.now());
  const task = createTaskFromRequirement(interpretationId, "R1", {
    id: id("task", clock.now()),
    runId,
    title: "implement feature",
    description: "WHAT: add feature",
    kind: "feature",
    acceptance: ["feature works"],
    complexity: "normal",
    baseCheckpointHash: fixture.base,
    now: clock.now(),
  });
  appendRunSkeleton(store, clock, fixture, runId, missionId, "CONVERGENCE_CHECK", task.id);
  store.events.append([
    {
      id: id("evt", clock.now() + 5),
      runId,
      ts: clock.now() + 5,
      type: "task.created",
      payload: { task: { ...task, state: "INTEGRATED" as const } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  const candidate = {
    id: id("cand", clock.now()),
    runId,
    taskId: task.id,
    attempt: 1,
    model: { provider: "p", model: "worker" },
    baseCheckpointHash: fixture.base,
    branch: "cand/1",
    worktreePath: join(fixture.root, "wt"),
    headCommit: fixture.integrated,
    state: "PASSED_GATES" as const,
    gateReport: {
      gatedCommit: fixture.integrated,
      checks: [],
      injectedAcceptance: [],
      failures: [],
      passed: true,
      diffStat: { files: 1, insertions: 2, deletions: 0 },
      createdAt: clock.now(),
    },
    transcriptRef: null,
    diffRef: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };
  store.events.append([
    {
      id: id("evt", clock.now() + 6),
      runId,
      ts: clock.now() + 6,
      type: "candidate.created",
      payload: { candidate },
      causedBy: [],
      actor: { kind: "worker", model: candidate.model },
      artifacts: [],
    },
  ]);
  for (let i = 1; i <= 3; i += 1) {
    const proof = (["correctness", "regression", "adversarial"] as const).map((axis, index) => ({
      id: id("rvex", clock.now() + i * 10 + index),
      runId,
      checkpointHash: fixture.integrated,
      roundIndex: i,
      axis,
      requestedModel: { provider: "p", model: `m${index + 1}` },
      completed: true,
      findings: [],
      startedAt: clock.now() + i,
      finishedAt: clock.now() + i,
    }));
    for (const [index, execution] of proof.entries()) {
      store.events.append([
        {
          id: id("evt", clock.now() + 110 + i * 10 + index),
          runId,
          ts: clock.now() + 110 + i * 10 + index,
          type: "review.finished",
          payload: { execution },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
      ]);
    }
    store.events.append([
      {
        id: id("evt", clock.now() + 100 + i),
        runId,
        ts: clock.now() + 100 + i,
        type: "clean_round.recorded",
        payload: {
          cleanRound: {
            id: id("cr", clock.now() + i),
            runId,
            checkpointHash: fixture.integrated,
            roundIndex: i,
            reviewRoundIndex: i,
            axes: proof.map((execution) => execution.axis),
            ensemble: proof.map((execution) => execution.requestedModel),
            rawFindings: 0,
            validatedBlocking: 0,
            novel: true,
            createdAt: clock.now() + i,
          },
        },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
  }
  const corpus = new MissionAcceptanceService(store, clock);
  corpus.recordRuntimeEvidence({
    missionId,
    requirementRef: "runtime.required_scenario",
    evidence: {
      id: id("rte", clock.now()),
      runId,
      scenarioId: "project-runtime",
      validator: "fixture",
      kind: "node_script",
      status: "passed",
      summary: "runtime passed",
      observations: {},
      checkpointHash: fixture.integrated,
      sideEffects: { policy: "safe", destructiveExternalEffectsAllowed: false },
      artifactHashes: [],
      startedAt: clock.now(),
      finishedAt: clock.now(),
    },
  });
  const finding = blockingFinding(fixture.integrated, { status: "UNCERTAIN", investigationRounds: 2, runId });
  store.events.append([
    {
      id: id("evt", clock.now() + 200),
      runId,
      ts: clock.now() + 200,
      type: "finding.raised",
      payload: { finding },
      causedBy: [],
      actor: { kind: "reviewer" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 201),
      runId,
      ts: clock.now() + 201,
      type: "finding.debate_started",
      payload: {
        findingId: finding.id,
        checkpointHash: finding.checkpointHash,
        roles: ROLES,
        causalValidationId: id("evt", clock.now() + 199),
      },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  return { runId, finding };
}

function appendRunSkeleton(
  store: Store,
  clock: FakeClock,
  fixture: Fixture,
  runId: string,
  missionId: string,
  phase: "VALIDATING" | "CONVERGENCE_CHECK",
  taskId: string = id("task", clock.now()),
): void {
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
    taskId,
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
    phase,
    control: "RUNNING" as const,
    currentCheckpointHash: fixture.integrated,
    baselineId: baseline.id,
    interpretationId: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    terminalReason: null,
  };
  store.events.append([
    { id: id("evt", clock.now()), runId, ts: clock.now(), type: "run.created", payload: { run }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
    { id: id("evt", clock.now() + 1), runId, ts: clock.now() + 1, type: "baseline.snapshotted", payload: { baseline }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
    { id: id("evt", clock.now() + 2), runId, ts: clock.now() + 2, type: "checkpoint.created", payload: { checkpoint }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
  ]);
}

function assertDebateBeforeTask(store: Store, runId: string): void {
  const events = store.events.list(runId);
  const started = events.find((event) => event.type === "finding.debate_started");
  const outcome = events.find((event) => event.type === "finding.debate_outcome");
  const task = events.find((event) => event.type === "task.created");
  expect(started).toBeDefined();
  expect(outcome).toBeDefined();
  expect(task).toBeDefined();
  expect(started!.seq).toBeLessThan(outcome!.seq);
  expect(outcome!.seq).toBeLessThan(task!.seq);
}

beforeEach(() => {
  activeCalls = [];
});

afterEach(() => {
  activeCalls = null;
});
