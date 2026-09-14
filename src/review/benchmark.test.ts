import { describe, expect, it } from "vitest";
import type { ReviewedFinding } from "./swarm.js";
import {
  canonicalJsonLine,
  primaryHit,
  scorePerModelDiscrimination,
  scoreQuality,
  scoreTeamDiscrimination,
  scoreTeamQuality,
  byTokensPerUniqueHit,
  scoreAxisRecall,
  strictIdHit,
  wilson95,
  type BenchmarkCellResult,
  type AxisRecall,
  type BenchmarkOracle,
} from "./benchmark.js";

const ORACLE: BenchmarkOracle = {
  cellId: "opaque-1",
  axis: "correctness",
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
    expect(strictIdHit([finding("INV-01", "src/other.ts", 8)], ORACLE)).toBe(false);
    expect(strictIdHit([finding("INV-01", "src/subject.ts", 9)], ORACLE)).toBe(false);
  });

  it("requires one blocking evidence ref to match both path and range", () => {
    expect(primaryHit([finding("c", "src/subject.ts", undefined)], ORACLE)).toBe(false);
    expect(primaryHit([finding("c", "src/other.ts", 8)], ORACLE)).toBe(false);
    expect(primaryHit([finding("c", "vendor/src/subject.ts", 8)], ORACLE)).toBe(false);
    expect(primaryHit([finding("c", "subject.ts", 8)], ORACLE)).toBe(false);
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
    expect(score.inputTokens).toBe(4);
    expect(score.outputTokens).toBe(100);
    expect(score.outputTokensPerPrimaryHit).toBe(50);
  });

  it("uses completed clean cells as the false-positive denominator", () => {
    const cells = [
      cell("clean", "completed_with_findings", [finding("c", "src/subject.ts", 8)], 1),
      cell("clean", "completed_empty", [], 1),
      cell("clean", "schema_failure", [], 1),
      cell("mutant", "completed_with_findings", [finding("INV-01", "src/subject.ts", 8)], 1),
      cell("mutant", "completed_with_findings", [finding("paraphrase", "src/subject.ts", 8)], 1),
      cell("mutant", "completed_empty", [], 1),
    ];
    const score = scoreQuality(cells);
    expect(score.cleanCompleted).toBe(2);
    expect(score.mutantCompleted).toBe(3);
    expect(score.falsePositiveRate).toBe(0.5);
    expect(score.primaryRecall).toBe(2 / 3);
    expect(score.strictIdRecall).toBe(1 / 3);
    expect(score.falsePositiveWilson95).toEqual(wilson95(1, 2));
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
      cell("mutant", "completed_empty", [], 1, "m1", 1, "pair-b"),
      cell("clean", "completed_empty", [], 1, "m1", 1, "pair-b"),
      cell("mutant", "completed_empty", [], 1, "m1", 2, "pair-a"),
      cell("clean", "completed_empty", [], 1, "m1", 2, "pair-a"),
      cell("mutant", "completed_with_findings", [hit], 1, "m1", 3, "pair-failed"),
      cell("clean", "transport_failure", [], null, "m1", 3, "pair-failed"),
    ];
    expect(scorePerModelDiscrimination(cells)).toEqual({ eligible: 3, discriminated: 1, rate: 1 / 3 });
    expect(scoreTeamDiscrimination(cells)).toEqual({ eligible: 3, discriminated: 1, rate: 1 / 3 });
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
    expect(team.outputTokensPerPrimaryHit).toBe(15);
    expect(scoreTeamDiscrimination(cells)).toEqual({ eligible: 1, discriminated: 1, rate: 1 });
    expect(scoreQuality([cell("mutant", "completed_empty", [], 5)])
      .outputTokensPerPrimaryHit).toBeNull();
    expect(scoreTeamQuality([cell("mutant", "completed_empty", [], 5)])
      .outputTokensPerPrimaryHit).toBeNull();
    const splitFailures = scoreTeamQuality([
      cell("mutant", "schema_failure", [], 3, "m1"),
      cell("mutant", "transport_failure", [], null, "m2"),
      cell("clean", "completed_empty", [], 4, "m1"),
      cell("clean", "completed_empty", [], 5, "m2"),
    ]);
    expect(splitFailures.schemaFailures).toBe(1);
    expect(splitFailures.transportFailures).toBe(1);
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

function axisCell(
  axis: string,
  pairId: string,
  findings: ReviewedFinding[],
  outputTokens: number,
  label: "clean" | "mutant" = "mutant",
  repetition = 1,
): BenchmarkCellResult {
  return {
    oracle: { ...ORACLE, axis: axis as BenchmarkOracle["axis"], pairId, label, repetition },
    model: { provider: "test", model: "m1" },
    family: "m1",
    outcome: "completed_with_findings",
    findings,
    usage: { inputTokens: 1, outputTokens, costUsd: 0 },
  };
}

/** A finding that lands on the oracle's own path and line, so `primaryHit` is true. */
function hits(): ReviewedFinding[] {
  return [finding(ORACLE.criterionId, ORACLE.path, ORACLE.line, ORACLE.endLine)];
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

describe("scoreAxisRecall", () => {
  it("credits a pair to the only axis that found it", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10),
      axisCell("correctness", "pair-A", [], 10),
      axisCell("regression", "pair-A", [], 10),
    ]);
    expect(recall["adversarial"]?.uniquePairIds).toEqual(["pair-A"]);
    expect(recall["correctness"]?.uniqueHits).toBe(0);
    expect(recall["regression"]?.uniqueHits).toBe(0);
  });

  /**
   * The case a per-cell implementation gets wrong. Uniqueness is a property of the pair across the
   * whole report: if two axes find it anywhere, it is unique to neither.
   */
  it("credits a pair to neither axis when two of them found it", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10),
      axisCell("correctness", "pair-A", hits(), 10),
      axisCell("regression", "pair-A", [], 10),
    ]);
    expect(recall["adversarial"]?.uniqueHits).toBe(0);
    expect(recall["correctness"]?.uniqueHits).toBe(0);
    expect(recall["adversarial"]?.hitPairIds).toEqual(["pair-A"]);
  });

  it("does not let a second cell of the same axis make a shared pair unique", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10),
      axisCell("adversarial", "pair-A", hits(), 10),
      axisCell("correctness", "pair-A", hits(), 10),
    ]);
    expect(recall["adversarial"]?.uniqueHits).toBe(0);
  });

  it("reports null rather than infinity or NaN for an axis with no unique hits", () => {
    const recall = scoreAxisRecall([
      axisCell("correctness", "pair-A", [], 10),
      axisCell("adversarial", "pair-A", hits(), 10),
    ]);
    const empty = recall["correctness"];
    expect(empty?.tokensPerUniqueHit).toBeNull();
    expect(empty?.tokensPerUniqueHit).not.toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(empty!.tokensPerUniqueHit as unknown as number)).toBe(false);
  });

  it("divides total tokens by unique hits, counting every cell of the axis", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10),
      axisCell("adversarial", "pair-B", [], 30),
      axisCell("correctness", "pair-A", [], 5),
    ]);
    // 2 cells of `adversarial`: (1+10) + (1+30) = 42 tokens over 1 unique pair.
    expect(recall["adversarial"]?.tokensPerUniqueHit).toBe(42);
  });

  /** P3.1 consumes this ordering; `null` as zero would rank an axis that found nothing cheapest. */
  it("orders null worst, below any finite cost", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10),
      axisCell("correctness", "pair-B", hits(), 100_000),
      axisCell("regression", "pair-A", [], 1),
    ]);
    const order = Object.values(recall).sort(byTokensPerUniqueHit).map((entry) => entry.axis);
    expect(order).toEqual(["adversarial", "correctness", "regression"]);
    expect(recall["regression"]?.tokensPerUniqueHit).toBeNull();
  });
});

describe("scoreAxisRecall boundaries", () => {
  /**
   * A `clean` cell has no planted defect, so a finding there is a false positive. Counting it as
   * recall would let an axis that only hallucinates look like the sole finder of a pair.
   */
  it("does not count a clean-site false positive as a unique hit", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10, "clean"),
      axisCell("correctness", "pair-A", [], 10, "mutant"),
      axisCell("regression", "pair-A", [], 10, "mutant"),
    ]);
    expect(recall["adversarial"]?.uniqueHits).toBe(0);
    expect(recall["adversarial"]?.hitPairIds).toEqual([]);
  });

  /** MC5 says "at least one cell", not "every cell". */
  it("counts an axis that hit in one repetition and missed in another", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10, "mutant", 1),
      axisCell("adversarial", "pair-A", [], 10, "mutant", 2),
      axisCell("correctness", "pair-A", [], 10, "mutant", 1),
    ]);
    expect(recall["adversarial"]?.uniqueHits).toBe(1);
  });

  it("treats two axes hitting the same pair in different repetitions as shared", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10, "mutant", 1),
      axisCell("correctness", "pair-A", hits(), 10, "mutant", 3),
    ]);
    expect(recall["adversarial"]?.uniqueHits).toBe(0);
    expect(recall["correctness"]?.uniqueHits).toBe(0);
  });

  /**
   * A partial run is expected on the free tier, and the per-axis table must not silently shrink to
   * the axes that happened to complete.
   */
  it("reports every configured axis even when a run produced no cells for it", () => {
    const recall = scoreAxisRecall([axisCell("correctness", "pair-A", hits(), 10)]);
    expect(Object.keys(recall).sort()).toEqual(["adversarial", "correctness", "regression"]);
    expect(recall["adversarial"]?.uniqueHits).toBe(0);
    expect(recall["adversarial"]?.tokensPerUniqueHit).toBeNull();
    expect(recall["adversarial"]?.quality.scheduled).toBe(0);
    expect(scoreAxisRecall([])["regression"]?.uniqueHits).toBe(0);
  });

  it("omits a usage-less cell from the token total without losing its hit", () => {
    const withoutUsage: BenchmarkCellResult = { ...axisCell("adversarial", "pair-A", hits(), 0), usage: null };
    const recall = scoreAxisRecall([withoutUsage, axisCell("adversarial", "pair-B", [], 30)]);
    expect(recall["adversarial"]?.uniqueHits).toBe(1);
    const adversarial = recall["adversarial"]!;
    expect(adversarial.inputTokens + adversarial.outputTokens).toBe(31);
  });

  /** The denominator has to be the unique-hit count, which one unique hit cannot distinguish. */
  it("divides by the unique-hit count, not by one", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 9),
      axisCell("adversarial", "pair-B", hits(), 9),
      axisCell("correctness", "pair-C", hits(), 5),
    ]);
    expect(recall["adversarial"]?.uniqueHits).toBe(2);
    // (1+9) + (1+9) = 20 over 2 unique pairs.
    expect(recall["adversarial"]?.tokensPerUniqueHit).toBe(10);
  });

  it("carries each axis's own quality slice", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10),
      axisCell("correctness", "pair-A", [], 10),
    ]);
    expect(recall["adversarial"]?.quality.scheduled).toBe(1);
    expect(recall["adversarial"]?.quality.primaryHits).toBe(1);
    expect(recall["correctness"]?.quality.primaryHits).toBe(0);
  });

  /**
   * MC9: the slice must be the same statistic as the aggregate it is printed beside, which is the
   * team OR over the two models — not `scoreQuality`'s per-cell aggregate. One model hitting and
   * the other missing the same cell is where the two disagree: team recall 1/1, per-cell 1/2.
   */
  it("scores each axis as a team, not as a bag of cells", () => {
    const sibling = (cell: BenchmarkCellResult, model: string): BenchmarkCellResult =>
      ({ ...cell, model: { provider: "test", model }, family: model });
    const hit = axisCell("adversarial", "pair-A", hits(), 10);
    const miss = axisCell("adversarial", "pair-A", [], 10);
    const cells = [sibling(hit, "m1"), sibling(miss, "m2")];
    expect(recallOf(cells).quality.primaryRecall).toBe(1);
    expect(scoreQuality(cells).primaryRecall).toBe(0.5);
    // Cost accounting is not an OR: both cells were scheduled and paid for.
    expect(recallOf(cells).quality.outputTokens).toBe(20);
  });

  /** Item 42's third headline figure is pair discrimination, on the same team grouping. */
  it("carries each axis's own pair discrimination", () => {
    const recall = scoreAxisRecall([
      axisCell("adversarial", "pair-A", hits(), 10, "mutant"),
      axisCell("adversarial", "pair-A", [], 10, "clean"),
      axisCell("correctness", "pair-A", hits(), 10, "mutant"),
      axisCell("correctness", "pair-A", hits(), 10, "clean"),
    ]);
    expect(recall["adversarial"]?.discrimination).toEqual({ eligible: 1, discriminated: 1, rate: 1 });
    expect(recall["correctness"]?.discrimination).toEqual({ eligible: 1, discriminated: 0, rate: 0 });
    expect(recall["regression"]?.discrimination).toEqual({ eligible: 0, discriminated: 0, rate: null });
  });
});

function recallOf(cells: readonly BenchmarkCellResult[]): AxisRecall {
  const entry = scoreAxisRecall(cells)["adversarial"];
  if (entry === undefined) throw new Error("missing adversarial recall");
  return entry;
}

describe("byTokensPerUniqueHit boundaries", () => {
  const at = (axis: string, tokensPerUniqueHit: number | null): AxisRecall =>
    ({ axis, hitPairIds: [], uniquePairIds: [], uniqueHits: 0, inputTokens: 0, outputTokens: 0,
       tokensPerUniqueHit, quality: scoreQuality([]),
       discrimination: { eligible: 0, discriminated: 0, rate: null } } as unknown as AxisRecall);

  it("orders null last from either operand position", () => {
    expect(byTokensPerUniqueHit(at("a", null), at("b", 5))).toBeGreaterThan(0);
    expect(byTokensPerUniqueHit(at("a", 5), at("b", null))).toBeLessThan(0);
  });

  it("orders finite costs ascending from either operand position", () => {
    expect(byTokensPerUniqueHit(at("a", 1), at("b", 5))).toBeLessThan(0);
    expect(byTokensPerUniqueHit(at("a", 5), at("b", 1))).toBeGreaterThan(0);
  });

  /** MC7: ties are reported, not broken on cost. The axis name only makes the order stable. */
  it("keeps a finite tie and a null/null pair stable by axis name rather than dropping one", () => {
    expect(byTokensPerUniqueHit(at("adversarial", 5), at("regression", 5))).toBeLessThan(0);
    expect(byTokensPerUniqueHit(at("regression", 5), at("adversarial", 5))).toBeGreaterThan(0);
    expect(byTokensPerUniqueHit(at("adversarial", null), at("regression", null))).toBeLessThan(0);
  });
});
