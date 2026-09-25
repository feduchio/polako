import { describe, expect, it } from "vitest";
import type { CorpusEntry } from "../domain/acceptance.js";
import { findingFingerprint, type Finding } from "../domain/finding.js";
import { createTaskFromValidFinding } from "../domain/task.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { fingerprintFinding } from "./fingerprint.js";
import {
  FindingValidator,
  ScriptedFindingEvidenceWorker,
  type CorpusAppender,
  type EvidenceAttempt,
} from "./validator.js";

const NOW = 1_700_000_000_000;
const HASH = "a".repeat(40);
const SHA = "b".repeat(64);

function rawFinding(overrides: Partial<Finding> = {}): Finding {
  const raw = {
    criterion: "auth.persistence",
    severity: "high" as const,
    blocking: true,
    claim: "logout leaves refresh token behind",
    evidence: [{ path: "src/auth/store.ts", line: 81 }],
    reproduction: ["login", "logout", "inspect storage"],
    suggestedCheck: "a regression test proves logout clears the token",
  };
  return {
    id: id("find", NOW),
    runId: id("run", NOW),
    checkpointHash: HASH,
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

class MemoryCorpus implements CorpusAppender {
  readonly entries: CorpusEntry[] = [];

  record(entry: Omit<CorpusEntry, "id" | "createdAt"> & { id?: string }): CorpusEntry {
    const saved = { ...entry, id: entry.id ?? id("corp", NOW), createdAt: NOW };
    this.entries.push(saved);
    return saved;
  }
}

function attempt(verdict: EvidenceAttempt["verdict"]): EvidenceAttempt {
  return {
    method: verdict === "VALID" ? "failing_test" : "deterministic_reproduction",
    verdict,
    rationale: `${verdict} after isolated reproduction`,
    evidenceRefs: verdict === "VALID" ? [{ sha256: SHA, kind: "test_output", bytes: 42 }] : [],
  };
}

function validator(verdict: EvidenceAttempt["verdict"], corpus = new MemoryCorpus()): {
  validator: FindingValidator;
  corpus: MemoryCorpus;
} {
  return {
    validator: new FindingValidator({
      clock: new FakeClock(NOW),
      worker: new ScriptedFindingEvidenceWorker(() => attempt(verdict)),
      corpus,
      maxInvestigationRounds: 2,
    }),
    corpus,
  };
}

describe("finding fingerprint and triage", () => {
  it("is stable across path separators, line numbers, and evidence order", () => {
    const finding = rawFinding();
    const equivalent = rawFinding({
      criterion: " auth.persistence ",
      claim: "logout  leaves refresh token behind",
      evidence: [{ path: "./src\\auth\\store.ts", line: 999 }],
    });
    expect(fingerprintFinding(equivalent)).toBe(fingerprintFinding(finding));
  });

  it("dedupes before spawning evidence work", async () => {
    let calls = 0;
    const finding = rawFinding();
    const existing = rawFinding({ id: id("find", NOW + 1), runId: finding.runId, status: "VALID" });
    const result = await new FindingValidator({
      clock: new FakeClock(NOW),
      worker: new ScriptedFindingEvidenceWorker(() => {
        calls++;
        return attempt("VALID");
      }),
      corpus: new MemoryCorpus(),
      maxInvestigationRounds: 2,
    }).validate({ finding, existingFindings: [existing], missionId: id("msn", NOW), requirementRef: "R1" });
    expect(result.finding.status).toBe("DUPLICATE");
    expect(result.finding.duplicateOf).toBe(existing.id);
    expect(calls).toBe(0);
  });

  it("notes unsupported reviewer opinions as noise", async () => {
    const finding = rawFinding({ evidence: [], reproduction: [], suggestedCheck: undefined });
    const { validator: subject } = validator("VALID");
    const result = await subject.validate({
      finding,
      existingFindings: [],
      missionId: id("msn", NOW),
      requirementRef: "R1",
    });
    expect(result.finding.status).toBe("NOTED");
    expect(result.validation).toBeNull();
  });

  it("notes a finding whose quote is not in the checkpoint without spawning evidence work", async () => {
    let calls = 0;
    const subject = new FindingValidator({
      clock: new FakeClock(NOW),
      worker: new ScriptedFindingEvidenceWorker(() => {
        calls++;
        return attempt("VALID");
      }),
      corpus: new MemoryCorpus(),
      maxInvestigationRounds: 2,
    });
    const mismatched = rawFinding({ evidenceMismatch: "evidence_mismatch: src/auth/store.ts:81 does not contain the quoted text" });
    const result = await subject.validate({ finding: mismatched, existingFindings: [], missionId: id("msn", NOW), requirementRef: "R1" });
    expect(result.finding.status).toBe("NOTED");
    expect(result.triage).toMatchObject({ disposition: "noise", reason: mismatched.evidenceMismatch });
    expect(calls).toBe(0);

    // The void citation must not absorb a later finding that cites the same code correctly.
    const noted = { ...result.finding, id: id("find", NOW + 2) };
    const honest = rawFinding({ id: id("find", NOW + 3), runId: mismatched.runId });
    const second = await subject.validate({ finding: honest, existingFindings: [noted], missionId: id("msn", NOW), requirementRef: "R1" });
    expect(second.finding.status).not.toBe("DUPLICATE");
    expect(calls).toBe(1);
  });
});

describe("FindingValidator verdicts", () => {
  it("VALID blocking creates coding work and appends acceptance evidence", async () => {
    const { validator: subject, corpus } = validator("VALID");
    const finding = rawFinding();
    const result = await subject.validate({
      finding,
      existingFindings: [],
      missionId: id("msn", NOW),
      requirementRef: "R1",
    });
    expect(result.finding.status).toBe("VALID");
    expect(result.task).toMatchObject({ kind: "bugfix", touchesProductCode: true });
    expect(result.task?.origin).toMatchObject({ kind: "valid_finding", verdict: "VALID" });
    expect(result.corpusEntry?.artifactHashes).toEqual([SHA]);
    expect(corpus.entries).toHaveLength(1);
  });

  it("UNCERTAIN creates investigation-only work and no corpus entry", async () => {
    const { validator: subject, corpus } = validator("UNCERTAIN");
    const result = await subject.validate({
      finding: rawFinding(),
      existingFindings: [],
      missionId: id("msn", NOW),
      requirementRef: "R1",
    });
    expect(result.finding.status).toBe("UNCERTAIN");
    expect(result.task).toMatchObject({ kind: "investigation", touchesProductCode: false });
    expect(result.corpusEntry).toBeNull();
    expect(corpus.entries).toHaveLength(0);
  });

  it("REJECTED creates no task and no corpus entry", async () => {
    const { validator: subject, corpus } = validator("REJECTED");
    const result = await subject.validate({
      finding: rawFinding(),
      existingFindings: [],
      missionId: id("msn", NOW),
      requirementRef: "R1",
    });
    expect(result.finding.status).toBe("REJECTED");
    expect(result.task).toBeNull();
    expect(result.corpusEntry).toBeNull();
    expect(corpus.entries).toHaveLength(0);
  });

  it("coding factory throws for UNCERTAIN verdict", async () => {
    const { validator: subject } = validator("UNCERTAIN");
    const result = await subject.validate({
      finding: rawFinding(),
      existingFindings: [],
      missionId: id("msn", NOW),
      requirementRef: "R1",
    });
    expect(result.validation?.verdict).toBe("UNCERTAIN");
    expect(() =>
      createTaskFromValidFinding(result.finding, result.validation!, {
        id: id("task", NOW),
        runId: result.finding.runId,
        title: "t",
        description: "d",
        kind: "bugfix",
        acceptance: ["a"],
        complexity: "normal",
        baseCheckpointHash: HASH,
        now: NOW,
      }),
    ).toThrow(/VALID/);
  });

  it("registers corpus evidence for VALID non-blocking findings without creating a coding task", async () => {
    const { validator: subject, corpus } = validator("VALID");
    const result = await subject.validate({
      finding: rawFinding({ blocking: false }),
      existingFindings: [],
      missionId: id("msn", NOW),
      requirementRef: "R1",
    });
    expect(result.finding.status).toBe("VALID");
    expect(result.task).toBeNull();
    expect(result.corpusEntry?.artifactHashes).toEqual([SHA]);
    expect(corpus.entries).toHaveLength(1);
  });
});
