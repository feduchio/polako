import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTestReport } from "../domain/testReport.js";
import { mutantsOf, type Mutant } from "./mutations.js";
import { SEEDS, type Seed } from "./seeds.js";

export interface PairRecord {
  id: string;
  seed: string;
  operator: string;
  change: string;
  line: number;
  module: string;
  behavior: string;
  /** Correct code with the weak test. */
  correctDir: string;
  /** The same fixture with one mutant the weak test misses and the oracle catches by assertion. */
  defectDir: string;
  /** The oracle test, placed at `oracle/oracle.test.mjs` inside a checkout to judge it. */
  oraclePath: string;
}

export const ORACLE_RELATIVE_PATH = "oracle/oracle.test.mjs";
const WEAK_RELATIVE_PATH = "tests/weak.test.mjs";

/**
 * Distinct correct/defect pairs from `SEEDS`, each validated mechanically: on the correct side the
 * weak test and the oracle pass; on the defect side the weak test still passes and the oracle fails
 * with an assertion — not a load error or a crash. Pairs spread over seeds first and operators
 * second, so a live tier's trials are not one oracle shape repeated.
 */
export function generatePairs(outDir: string, options: { limit?: number; seeds?: readonly string[] } = {}): { pairs: PairRecord[]; rejected: number } {
  const limit = options.limit ?? 20;
  const seeds = options.seeds === undefined ? SEEDS : SEEDS.filter((seed) => options.seeds?.includes(seed.id) === true);
  const perSeed = Math.ceil(limit / seeds.length) + 1;
  let rejected = 0;
  const bySeed: PairRecord[][] = [];
  for (const seed of seeds) {
    const root = join(outDir, seed.id);
    const correctDir = join(root, "correct");
    writeFixture(correctDir, seed, seed.source);
    if (!passes(correctDir, WEAK_RELATIVE_PATH) || !oracleVerdict(correctDir, seed).passed) {
      throw new Error(`seed ${seed.id}: the correct code does not pass its own tests`);
    }
    const oraclePath = join(root, "oracle.test.mjs");
    writeFileSync(oraclePath, seed.oracleTest);
    const chosen: PairRecord[] = [];
    const usedOperators = new Set<string>();
    const tried = new Set<number>();
    const mutants = mutantsOf(seed.source, seed.module);
    // Distinct operators first; the same operator at another line only when those run out.
    for (const distinct of [true, false]) {
      for (const [index, mutant] of mutants.entries()) {
        if (chosen.length >= perSeed) break;
        if (tried.has(index) || (distinct && usedOperators.has(mutant.operator))) continue;
        tried.add(index);
        const suffix = `${mutant.operator}-${String(mutant.line)}-${String(index)}`;
        const defectDir = join(root, `defect-${suffix}`);
        writeFixture(defectDir, seed, mutant.source);
        if (!acceptable(defectDir, seed)) {
          rejected += 1;
          rmSync(defectDir, { recursive: true, force: true });
          continue;
        }
        usedOperators.add(mutant.operator);
        chosen.push(record(`${seed.id}-${suffix}`, seed, mutant, correctDir, defectDir, oraclePath));
      }
    }
    bySeed.push(chosen);
  }
  const pairs: PairRecord[] = [];
  for (let round = 0; pairs.length < limit && bySeed.some((list) => list.length > round); round += 1) {
    for (const list of bySeed) {
      const pair = list[round];
      if (pair !== undefined && pairs.length < limit) pairs.push(pair);
    }
  }
  return { pairs, rejected };
}

function record(id: string, seed: Seed, mutant: Mutant, correctDir: string, defectDir: string, oraclePath: string): PairRecord {
  return { id, seed: seed.id, operator: mutant.operator, change: mutant.change, line: mutant.line, module: seed.module, behavior: seed.behavior, correctDir, defectDir, oraclePath };
}

function writeFixture(dir: string, seed: Seed, source: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `pair-${seed.id}`, private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  writeFileSync(join(dir, "src", seed.module), source);
  writeFileSync(join(dir, WEAK_RELATIVE_PATH), seed.weakTest);
}

function acceptable(dir: string, seed: Seed): boolean {
  if (!passes(dir, WEAK_RELATIVE_PATH)) return false;
  const verdict = oracleVerdict(dir, seed);
  return !verdict.passed && verdict.assertionOnly;
}

/** Run the oracle inside `dir`, then take it out again: a fixture never carries its oracle. */
export function oracleVerdict(dir: string, seed: Pick<Seed, "oracleTest">): { passed: boolean; assertionOnly: boolean } {
  mkdirSync(join(dir, "oracle"), { recursive: true });
  writeFileSync(join(dir, ORACLE_RELATIVE_PATH), seed.oracleTest);
  try {
    const result = run(dir, ORACLE_RELATIVE_PATH);
    const report = parseTestReport("node-test", result.stdout, result.stderr);
    return {
      passed: result.status === 0,
      assertionOnly: report.failures.length > 0 && report.failures.every((failure) => failure.kind === "assertion"),
    };
  } finally {
    rmSync(join(dir, "oracle"), { recursive: true, force: true });
  }
}

function passes(dir: string, file: string): boolean {
  return run(dir, file).status === 0;
}

function run(dir: string, file: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--test", file], { cwd: dir, encoding: "utf8", timeout: 5_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
