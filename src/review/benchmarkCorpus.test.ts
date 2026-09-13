import { describe, expect, it } from "vitest";
import {
  BENCHMARK_PATH,
  REVIEWER_BENCHMARK_PAIRS,
  addedFileDiff,
  benchmarkCorpusSha256,
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
    expect(benchmarkCorpusSha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(benchmarkCorpusSha256(REVIEWER_BENCHMARK_PAIRS.slice(0, 7)))
      .not.toBe(benchmarkCorpusSha256());
    expect(benchmarkCorpusSha256([...REVIEWER_BENCHMARK_PAIRS].reverse()))
      .toBe(benchmarkCorpusSha256());
    const first = REVIEWER_BENCHMARK_PAIRS[0];
    if (first === undefined) throw new Error("missing first pair");
    expect(benchmarkCorpusSha256([{ ...first, cleanSource: `${first.cleanSource}\n` }]))
      .not.toBe(benchmarkCorpusSha256([first]));
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
      const cleanDiff = addedFileDiff(pair, "clean");
      const mutantDiff = addedFileDiff(pair, "mutant");
      expect(pair.cleanSource.split("\n")[0]).toBe(`// ${pair.criterionId}: ${pair.property}`);
      expect(pair.mutantSource.split("\n")[0]).toBe(`// ${pair.criterionId}: ${pair.property}`);
      expect(/^\+\+\+ b\/(.+)$/m.exec(cleanDiff)?.[1]).toBe(BENCHMARK_PATH);
      expect(/^\+\+\+ b\/(.+)$/m.exec(mutantDiff)?.[1]).toBe(BENCHMARK_PATH);
      for (const label of ["clean", "mutant"] as const) {
        const diff = addedFileDiff(pair, label);
        expect(diff).toContain(`// ${pair.criterionId}: ${pair.property}`);
        expect(diff).not.toMatch(/\b(clean|mutant|defect|injected)\b/i);
        expect(diff).not.toContain("expectedLine");
        for (const family of REVIEWER_BENCHMARK_PAIRS.map((item) => item.family)) {
          expect(diff).not.toContain(family);
        }
      }
    }
  });

  it("rejects a pair whose clean and mutant sources differ on two lines", () => {
    const first = REVIEWER_BENCHMARK_PAIRS[0];
    if (first === undefined) throw new Error("missing first pair");
    const twoDefects = {
      ...first,
      mutantSource: first.mutantSource.replace(
        `// ${first.criterionId}: ${first.property}`,
        `// ${first.criterionId}: altered property`,
      ),
    };
    expect(() => changedLineSpan(twoDefects)).toThrow("must change exactly one line");
  });

  it("executes sibling invariants instead of assuming they pass", () => {
    const first = REVIEWER_BENCHMARK_PAIRS[0];
    if (first === undefined) throw new Error("missing first pair");
    const twoSemanticDefects = {
      ...first,
      mutantSource: first.mutantSource.replace(
        "spent <= cap",
        "spent <= cap || spent > cap",
      ),
    };
    expect(runInvariants(twoSemanticDefects, "mutant")).toEqual([
      { name: "equal cap rejected", passed: false },
      { name: "below cap accepted", passed: true },
      { name: "above cap rejected", passed: false },
    ]);

    const brokenFirstSibling = {
      ...first,
      mutantSource: first.mutantSource.replace(
        "spent <= cap",
        "spent < cap && spent === 0",
      ),
    };
    expect(runInvariants(brokenFirstSibling, "mutant")).toEqual([
      { name: "equal cap rejected", passed: true },
      { name: "below cap accepted", passed: false },
      { name: "above cap rejected", passed: true },
    ]);
  });
});
