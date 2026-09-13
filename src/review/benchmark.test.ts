import { describe, expect, it } from "vitest";
import type { ReviewedFinding } from "./swarm.js";
import {
  canonicalJsonLine,
  primaryHit,
  scorePerModelDiscrimination,
  scoreQuality,
  scoreTeamDiscrimination,
  scoreTeamQuality,
  strictIdHit,
  wilson95,
  type BenchmarkCellResult,
  type BenchmarkOracle,
} from "./benchmark.js";

const ORACLE: BenchmarkOracle = {
  cellId: "opaque-1",
  pairId: "pair-1",
  label: "mutant",
  criterionId: "INV-01",
  path: "src/subject.ts",
  line: 8,
  endLine: 8,
  repetition: 1,
};

describe("review benchmark scorer", () => {
  it("scores localisation independently from criterion-id discipline", () => {
    const paraphrase = finding("remaining can become negative", "b/src/subject.ts", 8);
    expect(primaryHit([paraphrase], ORACLE)).toBe(true);
    expect(strictIdHit([paraphrase], ORACLE)).toBe(false);
    expect(strictIdHit([finding("INV-01: negative remainder", "./src/subject.ts", 8)], ORACLE)).toBe(true);
    expect(strictIdHit([finding("inv-01", "a/src/subject.ts", 8)], ORACLE)).toBe(true);
    expect(strictIdHit([finding("INV-010", "src/subject.ts", 8)], ORACLE)).toBe(false);
    expect(strictIdHit([finding("xINV-01", "src/subject.ts", 8)], ORACLE)).toBe(false);
  });

  it("requires one blocking evidence ref to match both path and range", () => {
    expect(primaryHit([finding("c", "src/subject.ts", undefined)], ORACLE)).toBe(false);
    expect(primaryHit([finding("c", "src/other.ts", 8)], ORACLE)).toBe(false);
    expect(primaryHit([finding("c", "src/subject.ts", 9)], ORACLE)).toBe(false);
    expect(primaryHit([finding("c", "src/subject.ts", 7, 8)], ORACLE)).toBe(true);
    expect(primaryHit([finding("c", "src/subject.ts", 8, 8, false)], ORACLE)).toBe(false);

    const split = finding("c", "src/subject.ts", undefined);
    split.evidence.push({ path: "src/other.ts", line: 8, endLine: 8 });
    expect(primaryHit([split], ORACLE)).toBe(false);
    const miss = finding("c", "src/other.ts", 20);
    const implicitEnd = finding("c", "src/subject.ts", 8);
    delete implicitEnd.evidence[0]?.endLine;
    expect(primaryHit([miss, implicitEnd], ORACLE)).toBe(true);
  });

  it("keeps failures outside quality denominators but inside scheduled-cell rates", () => {
    const cells = [
      cell("mutant", "completed_with_findings", [finding("INV-01", "src/subject.ts", 8)], 10),
      cell("mutant", "completed_with_findings", [finding("paraphrase", "src/subject.ts", 8)], 20),
      cell("mutant", "completed_empty", [], 30),
      cell("mutant", "schema_failure", [], 40),
      cell("mutant", "transport_failure", [], null),
    ];
    const score = scoreQuality(cells);
    expect(score.scheduled).toBe(5);
    expect(score.completed).toBe(3);
    expect(score.completionRate).toBe(3 / 5);
    expect(score.primaryRecall).toBe(2 / 3);
    expect(score.strictIdRecall).toBe(1 / 3);
    expect(score.schemaFailures).toBe(1);
    expect(score.transportFailures).toBe(1);
    expect(score.outputTokens).toBe(100);
    expect(score.outputTokensPerPrimaryHit).toBe(50);
  });

  it("uses completed clean cells as the false-positive denominator", () => {
    const cells = [
      cell("clean", "completed_with_findings", [finding("c", "src/subject.ts", 8)], 1),
      cell("clean", "completed_empty", [], 1),
      cell("clean", "schema_failure", [], 1),
    ];
    expect(scoreQuality(cells).falsePositiveRate).toBe(0.5);
  });

  it("scores matched discrimination per model and as a two-model team", () => {
    const hit = finding("c", "src/subject.ts", 8);
    const cells = [
      cell("mutant", "completed_with_findings", [hit], 1, "m1", 1),
      cell("clean", "completed_empty", [], 1, "m1", 1),
      cell("mutant", "completed_with_findings", [hit], 1, "m2", 1),
      cell("clean", "completed_with_findings", [hit], 1, "m2", 1),
      cell("mutant", "transport_failure", [], null, "m1", 2),
      cell("clean", "completed_empty", [], 1, "m1", 2),
    ];
    expect(scorePerModelDiscrimination(cells)).toEqual({ eligible: 2, discriminated: 1, rate: 0.5 });
    expect(scoreTeamDiscrimination(cells)).toEqual({ eligible: 1, discriminated: 0, rate: 0 });
  });

  it("keys discrimination by pair and excludes either failed side", () => {
    const hit = finding("c", "src/subject.ts", 8);
    const cells = [
      cell("mutant", "completed_with_findings", [hit], 1, "m1", 1, "pair-a"),
      cell("clean", "completed_empty", [], 1, "m1", 1, "pair-a"),
      cell("mutant", "completed_with_findings", [hit], 1, "m1", 1, "pair-b"),
      cell("clean", "transport_failure", [], null, "m1", 1, "pair-b"),
    ];
    expect(scorePerModelDiscrimination(cells)).toEqual({ eligible: 1, discriminated: 1, rate: 1 });
  });

  it("uses OR across completed team models without hiding their failures", () => {
    const cells = [
      cell("mutant", "completed_with_findings", [finding("c", "src/subject.ts", 8)], 4, "m1"),
      cell("mutant", "completed_empty", [], 5, "m2"),
      cell("clean", "transport_failure", [], null, "m1"),
      cell("clean", "completed_empty", [], 6, "m2"),
    ];
    const team = scoreTeamQuality(cells);
    expect(team.primaryRecall).toBe(1);
    expect(team.falsePositiveRate).toBe(0);
    expect(team.scheduled).toBe(4);
    expect(team.completed).toBe(3);
    expect(team.transportFailures).toBe(1);
    expect(team.outputTokens).toBe(15);
  });

  it("uses the published Wilson literals and null at zero denominator", () => {
    expect(wilson95(0, 8)).toEqual({ low: 0, high: 0.3244156195108769 });
    expect(wilson95(4, 8)).toEqual({
      low: 0.21521252682444186,
      high: 0.7847874731755582,
    });
    expect(wilson95(8, 8)).toEqual({ low: 0.6755843804891231, high: 1 });
    expect(wilson95(0, 0)).toBeNull();
  });

  it("canonicalises object keys and includes one final newline", () => {
    expect(canonicalJsonLine({ z: 1, a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":1}\n');
  });
});

function finding(
  criterion: string,
  path: string,
  line: number | undefined,
  endLine = line,
  blocking = true,
): ReviewedFinding {
  return {
    criterion,
    severity: "high",
    blocking,
    claim: "claim",
    evidence: [{ path, ...(line === undefined ? {} : { line, endLine }) }],
    reproduction: ["step"],
  } as ReviewedFinding;
}

function cell(
  label: "clean" | "mutant",
  outcome: BenchmarkCellResult["outcome"],
  findings: ReviewedFinding[],
  outputTokens: number | null,
  model = "m1",
  repetition = 1,
  pairId = "pair-1",
): BenchmarkCellResult {
  return {
    oracle: { ...ORACLE, pairId, label, repetition },
    model: { provider: "test", model },
    family: model,
    outcome,
    findings,
    usage: outputTokens === null ? null : { inputTokens: 1, outputTokens, costUsd: 0 },
  };
}
