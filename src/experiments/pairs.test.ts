import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mutantsOf } from "./mutations.js";
import { generatePairs, oracleVerdict } from "./pairs.js";
import { SEEDS } from "./seeds.js";

const out = mkdtempSync(join(tmpdir(), "polish-pairs-"));
afterAll(() => { rmSync(out, { recursive: true, force: true }); });

describe("mutantsOf", () => {
  it("finds one mutant per operator site, by the parser", () => {
    const changes = mutantsOf("export const f = (a, b) => a < b && !a ? Math.min(a, 1) : true;\n").map((mutant) => `${mutant.operator}: ${mutant.change}`);
    expect(changes).toEqual([
      "swap-logical: && -> ||",
      "swap-comparison: < -> <=",
      "remove-negation: ! removed",
      "swap-min-max: Math.min -> Math.max",
      "off-by-one: 1 -> 2",
      "off-by-one: 1 -> 0",
      "flip-boolean: true -> false",
    ]);
  });
});

describe("generatePairs", () => {
  it("yields at least 20 distinct pairs, each one the weak test misses and the oracle catches by assertion", { timeout: 120_000 }, () => {
    const { pairs } = generatePairs(out, { limit: 20 });
    expect(pairs).toHaveLength(20);
    expect(new Set(pairs.map((pair) => pair.id)).size).toBe(20);
    expect(new Set(pairs.map((pair) => pair.seed)).size).toBe(SEEDS.length);
    for (const pair of pairs) {
      const seed = SEEDS.find((item) => item.id === pair.seed)!;
      expect(readFileSync(join(pair.defectDir, "src", pair.module), "utf8")).not.toBe(seed.source);
      expect(existsSync(join(pair.defectDir, "oracle"))).toBe(false);
    }
    const sample = pairs[0]!;
    const seed = SEEDS.find((item) => item.id === sample.seed)!;
    expect(oracleVerdict(sample.defectDir, seed)).toEqual({ passed: false, assertionOnly: true });
    expect(oracleVerdict(sample.correctDir, seed).passed).toBe(true);
  });
});
