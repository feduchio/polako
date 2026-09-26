import { describe, expect, it } from "vitest";
import { findingFingerprint, type Finding, type FindingValidation } from "../domain/finding.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import {
  assertDebateMayStart,
  collectPreDebateEvidenceRefs,
  deriveDebateCorpusKind,
  legalDebateValid,
  nextDebateStep,
  parseJudgeVerdict,
  rolePrompt,
  threeDistinctDebateRoles,
} from "./debate.js";

const NOW = 1_700_000_000_000;
const HASH = "a".repeat(40);
const SHA = "b".repeat(64);

function finding(overrides: Partial<Finding> = {}): Finding {
  const raw = {
    criterion: "auth.persistence",
    severity: "high" as const,
    blocking: true,
    claim: "logout leaves refresh token behind",
    evidence: [{ path: "src/auth/store.ts", line: 81 }],
    reproduction: ["pnpm test auth"],
  };
  return {
    id: id("find", NOW),
    runId: id("run", NOW),
    checkpointHash: HASH,
    axis: "correctness",
    reportedBy: { kind: "reviewer" },
    status: "UNCERTAIN",
    duplicateOf: null,
    fingerprint: findingFingerprint(raw),
    investigationRounds: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...raw,
    ...overrides,
  };
}

describe("finding debate helpers", () => {
  it("refuses non-UNCERTAIN entry", () => {
    expect(() => {
      assertDebateMayStart(finding({ status: "VALID" }));
    }).toThrow(/UNCERTAIN/);
    expect(() => {
      assertDebateMayStart(finding({ status: "RAW" }));
    }).toThrow(/UNCERTAIN/);
    assertDebateMayStart(finding());
  });

  it("requires three distinct model refs", () => {
    const a = { provider: "scripted", model: "a" };
    const b = { provider: "scripted", model: "b" };
    const c = { provider: "scripted", model: "c" };
    expect(threeDistinctDebateRoles({ prosecutor: a, defender: b, judge: c })).toBe(true);
    expect(threeDistinctDebateRoles({ prosecutor: a, defender: b, judge: a })).toBe(false);
    expect(threeDistinctDebateRoles({ prosecutor: a, defender: a, judge: b })).toBe(false);
  });

  it("tells prosecutor, defender and judge that a true claim of correct behavior is not a defect", () => {
    const praise = finding({ claim: "The add function returns the sum of its arguments." });
    for (const role of ["prosecutor", "defender", "judge"] as const) {
      const prompt = rolePrompt(role, praise, [], [], [], 1);
      expect(prompt, role).toContain("VALID means the change has the defect the claim describes");
      expect(prompt, role).toContain("names no defect and is REJECTED however true it is");
    }
  });

  it("gives every role the mission its verdict is defined against", () => {
    const claim = finding({ claim: "The add function does not handle the case where the input is not a number." });
    const mission = {
      goals: ["add sums its arguments"],
      requirements: [{ ref: "R1", statement: "add returns the sum of its arguments", acceptance: ["tests/add.test.mjs passes"] }],
      constraints: [],
      nonGoals: ["input validation"],
    };
    for (const role of ["prosecutor", "defender", "judge"] as const) {
      const prompt = rolePrompt(role, claim, [], [], [], 1, mission);
      expect(prompt, role).toContain("no mission requirement asks for, and that the change did not break, is REJECTED");
      expect(prompt, role).toContain('"statement":"add returns the sum of its arguments"');
      expect(prompt, role).toContain('"nonGoals":["input validation"]');
    }
  });

  it("parses structured judge JSON and rejects malformed or empty", () => {
    expect(parseJudgeVerdict('{"verdict":"VALID","rationale":"reproduced"}')).toEqual({
      verdict: "VALID",
      rationale: "reproduced",
    });
    expect(parseJudgeVerdict("```json\n{\"verdict\":\"REJECTED\",\"rationale\":\"no repro\"}\n```")).toEqual({
      verdict: "REJECTED",
      rationale: "no repro",
    });
    expect(parseJudgeVerdict("")).toBeNull();
    expect(parseJudgeVerdict("{")).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"VALID","rationale":""}')).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"MAYBE","rationale":"x"}')).toBeNull();
  });

  it("treats only pre-debate validation artifacts as VALID evidence", () => {
    const clock = new FakeClock(NOW);
    const subject = finding();
    const prior: FindingValidation = {
      id: id("fval", clock.now()),
      findingId: subject.id,
      runId: subject.runId,
      method: "failing_test",
      verdict: "UNCERTAIN",
      rationale: "flaky",
      evidenceRefs: [{ sha256: SHA, kind: "test_output", bytes: 12 }],
      performedBy: { kind: "evidence_agent" },
      createdAt: clock.now(),
    };
    const debateOnly: FindingValidation = {
      ...prior,
      id: id("fval", clock.now() + 1),
      method: "finding_debate",
      verdict: "VALID",
      evidenceRefs: [{ sha256: "c".repeat(64), kind: "debate.judge", bytes: 8 }],
    };
    const refs = collectPreDebateEvidenceRefs(subject, [prior, debateOnly]);
    expect(refs).toEqual([{ sha256: SHA, kind: "test_output", bytes: 12 }]);
    expect(legalDebateValid(refs)).toBe(true);
    expect(legalDebateValid([])).toBe(false);
    expect(deriveDebateCorpusKind([prior], refs)).toBe("regression_test");
    expect(deriveDebateCorpusKind([debateOnly], [])).toBe("runtime_scenario");
  });

  it("walks prosecutor/defender/judge per round without re-rolling completed roles", () => {
    const first = nextDebateStep([], 2);
    expect(first).toEqual({ role: "prosecutor", roundIndex: 1 });
    const afterP = nextDebateStep([{ findingId: "f", checkpointHash: HASH, role: "prosecutor", roundIndex: 1, text: "p" }], 2);
    expect(afterP).toEqual({ role: "defender", roundIndex: 1 });
    const afterJudgeValid = nextDebateStep(
      [
        { findingId: "f", checkpointHash: HASH, role: "prosecutor", roundIndex: 1, text: "p" },
        { findingId: "f", checkpointHash: HASH, role: "defender", roundIndex: 1, text: "d" },
        {
          findingId: "f",
          checkpointHash: HASH,
          role: "judge",
          roundIndex: 1,
          text: '{"verdict":"VALID","rationale":"ok"}',
        },
      ],
      2,
    );
    expect(afterJudgeValid).toEqual({ done: true, lastVerdict: "VALID" });
  });
});
