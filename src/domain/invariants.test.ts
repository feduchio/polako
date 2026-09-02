import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { id } from "../shared/ids.js";
import { compareToBaseline, hasRegression, type BaselineSnapshot, type CheckResult } from "./checks.js";
import { dominates, emptyFindingCounts, equivalentEvidence, type EvidenceVector } from "./checkpoint.js";
import { cleanRoundsFor, hasConverged, isNovelRound, type CleanRound } from "./convergence.js";
import { FactStrictSchema, isGroundTruth, promoteToVerified, type Fact } from "./fact.js";
import { FindingValidationStrictSchema, findingFingerprint, type Finding, type FindingValidation } from "./finding.js";
import { createMission, missionIsIntact } from "./mission.js";
import {
  TaskOriginSchema,
  TaskStrictSchema,
  createInvestigationTask,
  createTaskFromRequirement,
  createTaskFromValidFinding,
  type TaskDraft,
} from "./task.js";

const NOW = 1_700_000_000_000;
const HASH = "a".repeat(40);
const SHA = "b".repeat(64);

function finding(overrides: Partial<Finding> = {}): Finding {
  const raw = { criterion: "auth.persistence", claim: "logout leaves refresh token behind", evidence: [{ path: "src/auth/store.ts", line: 81 }] };
  return {
    id: id("find"),
    runId: id("run"),
    checkpointHash: HASH,
    axis: "correctness",
    reportedBy: { kind: "reviewer", model: { provider: "p", model: "m" } },
    status: "VALID",
    duplicateOf: null,
    fingerprint: findingFingerprint(raw),
    investigationRounds: 0,
    severity: "high",
    blocking: true,
    reproduction: ["login", "logout", "inspect storage"],
    createdAt: NOW,
    updatedAt: NOW,
    ...raw,
    ...overrides,
  };
}

function validation(f: Finding, overrides: Partial<FindingValidation> = {}): FindingValidation {
  return {
    id: id("fval"),
    findingId: f.id,
    runId: f.runId,
    method: "failing_test",
    verdict: "VALID",
    rationale: "regression test fails on base and reproduces the claim",
    evidenceRefs: [{ sha256: SHA, kind: "test_output", bytes: 10 }],
    performedBy: { kind: "evidence_agent" },
    createdAt: NOW,
    ...overrides,
  };
}

function draft(kind: TaskDraft["kind"] = "bugfix"): TaskDraft {
  return {
    id: id("task"),
    runId: id("run"),
    title: "t",
    description: "WHAT/WHY",
    kind,
    acceptance: ["regression test passes"],
    complexity: "normal",
    baseCheckpointHash: HASH,
    now: NOW,
  };
}

describe("task origin invariant", () => {
  it("VALID + blocking finding with VALID validation creates a coding task", () => {
    const f = finding();
    const t = createTaskFromValidFinding(f, validation(f), draft());
    expect(t.origin.kind).toBe("valid_finding");
    expect(t.touchesProductCode).toBe(true);
  });

  it("rejects UNCERTAIN, REJECTED, RAW, non-blocking findings and mismatched validations", () => {
    for (const status of ["UNCERTAIN", "REJECTED", "RAW", "NOTED", "VALIDATING"] as const) {
      const f = finding({ status });
      expect(() => createTaskFromValidFinding(f, validation(f), draft())).toThrow(/VALID finding/);
    }
    const nb = finding({ blocking: false });
    expect(() => createTaskFromValidFinding(nb, validation(nb), draft())).toThrow(/blocking/);
    const f = finding();
    expect(() => createTaskFromValidFinding(f, validation(f, { verdict: "UNCERTAIN" }), draft())).toThrow(/VALID/);
    expect(() => createTaskFromValidFinding(f, validation(finding()), draft())).toThrow(/belong/);
  });

  it("the origin schema cannot even represent a non-VALID finding verdict", () => {
    const bad = { kind: "valid_finding", findingId: id("find"), validationId: id("fval"), verdict: "UNCERTAIN" };
    expect(TaskOriginSchema.safeParse(bad).success).toBe(false);
    const rejected = { kind: "rejected_finding", findingId: id("find") };
    expect(TaskOriginSchema.safeParse(rejected).success).toBe(false);
  });

  it("UNCERTAIN findings spawn only bounded investigation tasks that never touch product code", () => {
    const f = finding({ status: "UNCERTAIN", investigationRounds: 0 });
    const t = createInvestigationTask(f, 2, { ...draft(), kind: undefined } as unknown as Omit<TaskDraft, "kind">);
    expect(t.kind).toBe("investigation");
    expect(t.touchesProductCode).toBe(false);
    expect(t.origin).toMatchObject({ kind: "investigation", round: 1 });

    const exhausted = finding({ status: "UNCERTAIN", investigationRounds: 2 });
    expect(() => createInvestigationTask(exhausted, 2, draft())).toThrow(/exhausted/);
    const valid = finding({ status: "VALID" });
    expect(() => createInvestigationTask(valid, 2, draft())).toThrow(/UNCERTAIN/);
  });

  it("schema forbids an investigation task that touches product code, and a coding task with investigation origin", () => {
    const f = finding({ status: "UNCERTAIN" });
    const t = createInvestigationTask(f, 2, draft());
    expect(TaskStrictSchema.safeParse({ ...t, touchesProductCode: true }).success).toBe(false);
    expect(TaskStrictSchema.safeParse({ ...t, kind: "bugfix" }).success).toBe(false);
    const req = createTaskFromRequirement(id("mint"), "R1", draft("feature"));
    expect(TaskStrictSchema.safeParse({ ...req, kind: "investigation" }).success).toBe(false);
  });

  it("a VALID validation without evidence artifacts is invalid", () => {
    const f = finding();
    expect(FindingValidationStrictSchema.safeParse(validation(f, { evidenceRefs: [] })).success).toBe(false);
    expect(FindingValidationStrictSchema.safeParse(validation(f, { verdict: "REJECTED", evidenceRefs: [] })).success).toBe(true);
  });
});

describe("fact provenance invariant", () => {
  const inferred: Fact = {
    id: id("fact"),
    runId: id("run"),
    kind: "architecture",
    statement: "state lives in mobx stores",
    provenanceKind: "llm_inferred",
    provenanceRefs: [id("evt")],
    evidenceRefs: [],
    confidence: 0.99,
    tags: [],
    files: [],
    supersededBy: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("confidence alone never makes a fact verified", () => {
    expect(isGroundTruth(inferred)).toBe(false);
    expect(FactStrictSchema.safeParse({ ...inferred, provenanceKind: "verified" }).success).toBe(false);
  });

  it("promotion requires an evidence event and only applies to inferred facts", () => {
    const verified = promoteToVerified(inferred, id("evt"), NOW + 1);
    expect(verified.provenanceKind).toBe("verified");
    expect(verified.evidenceRefs).toHaveLength(1);
    expect(isGroundTruth(verified)).toBe(true);
    expect(() => promoteToVerified(verified, id("evt"), NOW)).toThrow(/only llm_inferred/);
    expect(() => promoteToVerified({ ...inferred, provenanceKind: "deterministic", confidence: null }, id("evt"), NOW)).toThrow();
  });

  it("deterministic facts carry no model confidence", () => {
    expect(FactStrictSchema.safeParse({ ...inferred, provenanceKind: "deterministic", confidence: 0.5 }).success).toBe(false);
    expect(FactStrictSchema.safeParse({ ...inferred, provenanceKind: "deterministic", confidence: null }).success).toBe(true);
  });
});

describe("evidence dominance is a strict partial order", () => {
  const sev = () => fc.record({ critical: fc.nat(3), high: fc.nat(3), medium: fc.nat(3), low: fc.nat(3), info: fc.nat(3) });
  const vec: fc.Arbitrary<EvidenceVector> = fc.record({
    gates: fc.record({ test: fc.constantFrom("pass", "fail", "error"), lint: fc.constantFrom("pass", "fail") }),
    testsPassed: fc.nat(50),
    testsFailed: fc.nat(5),
    testsTotal: fc.nat(55),
    openValidatedFindings: sev(),
    diffLinesFromBaseline: fc.nat(500),
  });

  it("irreflexive", () => {
    fc.assert(fc.property(vec, (a) => !dominates(a, a)));
  });
  it("asymmetric", () => {
    fc.assert(fc.property(vec, vec, (a, b) => !(dominates(a, b) && dominates(b, a))));
  });
  it("transitive", () => {
    fc.assert(fc.property(vec, vec, vec, (a, b, c) => !(dominates(a, b) && dominates(b, c)) || dominates(a, c)));
  });
  it("equivalent vectors do not dominate each other", () => {
    fc.assert(fc.property(vec, (a) => equivalentEvidence(a, { ...a, diffLinesFromBaseline: a.diffLinesFromBaseline + 1 }) && !dominates(a, { ...a })));
  });
  it("fixing one finding while breaking a test is not an improvement", () => {
    const base: EvidenceVector = {
      gates: { test: "pass" },
      testsPassed: 10,
      testsFailed: 0,
      testsTotal: 10,
      openValidatedFindings: { ...emptyFindingCounts(), high: 1 },
      diffLinesFromBaseline: 0,
    };
    const next: EvidenceVector = { ...base, gates: { test: "fail" }, testsPassed: 9, testsFailed: 1, openValidatedFindings: emptyFindingCounts() };
    expect(dominates(next, base)).toBe(false);
    expect(dominates(base, next)).toBe(false);
  });
});

describe("clean rounds belong to a checkpoint hash", () => {
  const round = (hash: string, i: number, model = "m1"): CleanRound => ({
    id: id("cr"),
    runId: id("run"),
    checkpointHash: hash,
    roundIndex: i,
    axes: ["correctness"],
    ensemble: [{ provider: "p", model }],
    rawFindings: 0,
    validatedBlocking: 0,
    novel: true,
    createdAt: NOW,
  });

  it("any code change resets the count", () => {
    const rounds = [round(HASH, 1), round(HASH, 2), round(HASH, 3)];
    expect(hasConverged(rounds, HASH, 3)).toBe(true);
    const newHash = "c".repeat(40);
    expect(cleanRoundsFor(rounds, newHash)).toHaveLength(0);
    expect(hasConverged(rounds, newHash, 1)).toBe(false);
  });

  it("novelty is informational and per-checkpoint", () => {
    const prev = [round(HASH, 1, "m1")];
    expect(isNovelRound(prev, round(HASH, 2, "m1"))).toBe(false);
    expect(isNovelRound(prev, round(HASH, 2, "m2"))).toBe(true);
    expect(isNovelRound(prev, round("d".repeat(40), 1, "m1"))).toBe(true);
  });
});

describe("baseline-relative regression", () => {
  const check = (name: string, failing: string[], total: number, status: CheckResult["status"] = failing.length ? "fail" : "pass"): CheckResult => ({
    name,
    kind: "test",
    status,
    exitCode: status === "pass" ? 0 : 1,
    durationMs: 1,
    summary: { total, passed: total - failing.length, failed: failing.length, skipped: 0, failingTests: failing },
    outputRef: null,
  });
  const baseline: BaselineSnapshot = {
    id: id("base"),
    runId: id("run"),
    commitHash: HASH,
    checks: [check("test", ["flaky.spec::x"], 100), check("lint", [], 0)],
    configHashes: {},
    scriptsHash: SHA,
    toolchain: {},
    createdAt: NOW,
  };

  it("pre-existing failures are not regressions", () => {
    const delta = compareToBaseline(baseline, [check("test", ["flaky.spec::x"], 100), check("lint", [], 0)]);
    expect(hasRegression(delta)).toBe(false);
  });

  it("fewer tests than baseline is flagged as possible silencing", () => {
    const delta = compareToBaseline(baseline, [check("test", [], 90), check("lint", [], 0)]);
    expect(delta.missing).toHaveLength(1);
    expect(hasRegression(delta)).toBe(true);
  });

  it("newly failing tests and degraded checks are regressions", () => {
    const delta = compareToBaseline(baseline, [check("test", ["flaky.spec::x", "auth.spec::y"], 100), check("lint", [], 0, "fail")]);
    expect(delta.newlyFailing).toEqual(["test::auth.spec::y"]);
    expect(delta.degradedChecks).toEqual(["lint"]);
  });
});

describe("mission immutability", () => {
  it("hash covers the user's words and constraints; tampering is detectable", () => {
    const m = createMission({ id: id("msn"), projectPath: "/p", text: "fix it", userConstraints: ["no scope creep"], createdAt: NOW });
    expect(missionIsIntact(m)).toBe(true);
    expect(missionIsIntact({ ...m, text: "fix it and add dark mode" })).toBe(false);
    expect(missionIsIntact({ ...m, userConstraints: [] })).toBe(false);
  });
});
