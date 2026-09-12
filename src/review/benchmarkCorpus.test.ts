import { describe, expect, it } from "vitest";
import {
  BENCHMARK_PATH,
  REVIEWER_BENCHMARK_PAIRS,
  addedFileDiff,
  changedLineSpan,
  runInvariants,
} from "./benchmarkCorpus.js";

describe("reviewer benchmark corpus", () => {
  it("contains eight fixed, opaque, single-substitution pairs", () => {
    expect(REVIEWER_BENCHMARK_PAIRS).toHaveLength(8);
    expect(new Set(REVIEWER_BENCHMARK_PAIRS.map((pair) => pair.family)).size).toBe(8);
    for (const pair of REVIEWER_BENCHMARK_PAIRS) {
      expect(pair.path).toBe(BENCHMARK_PATH);
      expect(pair.pairId).toMatch(/^pair-\d{2}$/);
      expect(pair.criterionId).toMatch(/^INV-\d{2}$/);
      expect(changedLineSpan(pair)).toEqual({ line: 2, endLine: 2 });
      expect(pair.cleanSource.split("\n")).toHaveLength(pair.mutantSource.split("\n").length);
    }
  });

  it("passes every clean suite and fails only the named mutant invariant", () => {
    for (const pair of REVIEWER_BENCHMARK_PAIRS) {
      const clean = runInvariants(pair, "clean");
      const mutant = runInvariants(pair, "mutant");
      expect(clean, pair.pairId).toEqual([
        { name: pair.invariants[0].name, passed: true },
        { name: pair.invariants[1].name, passed: true },
        { name: pair.invariants[2].name, passed: true },
      ]);
      expect(mutant, pair.pairId).toEqual([
        { name: pair.invariants[0].name, passed: false },
        { name: pair.invariants[1].name, passed: true },
        { name: pair.invariants[2].name, passed: true },
      ]);
    }
  });

  it("keeps labels and oracle language out of each diff", () => {
    for (const pair of REVIEWER_BENCHMARK_PAIRS) {
      for (const label of ["clean", "mutant"] as const) {
        const diff = addedFileDiff(pair, label);
        expect(diff).toContain(`// ${pair.criterionId}: ${pair.property}`);
        expect(diff).not.toMatch(/\b(clean|mutant|defect|injected)\b/i);
        expect(diff).not.toContain("expectedLine");
      }
    }
  });
});
