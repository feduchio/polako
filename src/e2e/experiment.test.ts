import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatePairs } from "../experiments/pairs.js";
import { runPairSide, type TrialDriver } from "../experiments/runner.js";
import { SEEDS } from "../experiments/seeds.js";
import { projectExperiment, trialsFrom } from "../observe/experiments.js";
import { destroyScenario, drive, scriptByPurpose, startScenario, type ScenarioEnv } from "./scenario.js";

/**
 * The experiment runner end to end on scripted models: one pair, both sides, one arm that fixes
 * the defect and one that claims there is nothing to change. The oracle, not the run, decides.
 */
let env: ScenarioEnv | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await destroyScenario(env);
  env = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MODELS = ["wkr", "xrev", "yjdg", "zdef"];

describe("experiment runner", () => {
  it("records each side's verdict against the oracle and reports false demonstrations and silent misses", { timeout: 120_000 }, async () => {
    const out = mkdtempSync(join(tmpdir(), "polish-exp-"));
    dirs.push(out);
    const { pairs } = generatePairs(join(out, "pairs"), { limit: 1, seeds: ["clamp"] });
    const pair = pairs[0]!;
    const seed = SEEDS.find((item) => item.id === "clamp")!;
    env = await startScenario("nothing-to-do", { models: MODELS });
    const scenario = env;
    const driver: TrialDriver = {
      store: scenario.service.store,
      startRun: async (project, mission) => ((await scenario.service.handle("run", { project, mission, runtime: "auto" })) as { id: string }).id,
      waitForTerminal: async (runId) => (await drive(scenario, runId, 200)).run,
    };
    let fixes = true;
    scriptByPurpose(scenario.provider, MODELS, {
      agent: [
        {
          matches: () => fixes,
          calls: [{ name: "write", arguments: { path: `src/${pair.module}`, content: seed.source } }, { name: "finish", arguments: { summary: "fixed" } }],
        },
        {
          matches: () => !fixes,
          calls: [{ name: "run_command", arguments: { argv: ["npm", "run", "test"] } }, { name: "finish", arguments: { summary: "fine", noChange: { reason: "the test passes" } } }],
        },
      ],
      review: () => [],
      debate: () => "no debate",
    });
    const options = (arm: string) => ({ experimentId: "exp-1", arm, workDir: join(out, "work", arm) });

    const fixed = await runPairSide(driver, pair, "defect", options("fixer"));
    expect(fixed).toMatchObject({ side: "defect", phase: "DONE", terminalCode: "converged", oraclePassed: true, demonstratedBlocking: 0 });

    fixes = false;
    const missed = await runPairSide(driver, pair, "defect", options("claimer"));
    expect(missed).toMatchObject({ phase: "DONE", terminalCode: "no_change_required", oraclePassed: false });
    const correct = await runPairSide(driver, pair, "correct", options("claimer"));
    expect(correct).toMatchObject({ side: "correct", oraclePassed: true, demonstratedBlocking: 0 });

    const events = [fixed, missed, correct].flatMap((trial) => scenario.service.store.events.list(trial.runId, { types: ["experiment.trial_recorded"] }));
    const report = projectExperiment("exp-1", trialsFrom(events));
    const claimer = report.arms.find((arm) => arm.arm === "claimer")!;
    expect(claimer.falseDemonstrated).toMatchObject({ count: 0, of: 1 });
    expect(claimer.silentMiss.of).toBe(1);
    expect(claimer.silentMiss.count).toBe(1);
  });
});
