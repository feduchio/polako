import { describe, expect, it } from "vitest";
import type { ExperimentTrial } from "../domain/experiment.js";
import { binomialUpperBound, projectExperiment, renderExperiment } from "./experiments.js";

function trial(overrides: Partial<ExperimentTrial>): ExperimentTrial {
  return {
    experimentId: "e1", arm: "base", pairId: "p", side: "correct", runId: "run_01hf7ymw8g7y2vae93crba", phase: "DONE",
    terminalCode: "converged", demonstratedBlocking: 0, examined: 1, validated: 1, oraclePassed: true, tokens: 100, ...overrides,
  };
}

describe("experiment report", () => {
  it("bounds a zero count near 3/n and grows with the count", () => {
    expect(binomialUpperBound(0, 20, 0.95)).toBeCloseTo(1 - 0.05 ** (1 / 20), 6);
    expect(binomialUpperBound(0, 20, 0.95)).toBeCloseTo(0.139, 3);
    expect(binomialUpperBound(1, 20, 0.95)).toBeCloseTo(0.216, 2);
    expect(binomialUpperBound(0, 0, 0.95)).toBe(1);
  });

  it("counts false demonstrations on correct code and silent misses on planted defects, per arm", () => {
    const report = projectExperiment("e1", [
      trial({ side: "correct" }),
      trial({ side: "correct", demonstratedBlocking: 1 }),
      trial({ side: "defect", oraclePassed: true }),
      trial({ side: "defect", oraclePassed: false }),
      trial({ side: "defect", oraclePassed: false, terminalCode: "converged_with_unexamined" }),
      trial({ side: "defect", oraclePassed: false, terminalCode: "no_change_required" }),
      trial({ arm: "advisor", side: "correct" }),
      trial({ experimentId: "other" }),
    ]);
    expect(report.arms.map((arm) => arm.arm)).toEqual(["advisor", "base"]);
    const base = report.arms[1]!;
    expect(base.falseDemonstrated).toMatchObject({ count: 1, of: 2 });
    expect(base.silentMiss).toMatchObject({ count: 2, of: 4 });
    expect(base.examination).toEqual({ examined: 6, validated: 6 });
    expect(renderExperiment(report)).toContain("- base: 6 trials; false demonstrated 1/2");
  });
});
