import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_ACTOR } from "../domain/common.js";
import { EXPERIMENT_TRIAL_EVENT, ExperimentTrialSchema, type ExperimentTrial } from "../domain/experiment.js";
import type { Run } from "../domain/run.js";
import { Git } from "../sandbox/git.js";
import { id } from "../shared/ids.js";
import type { Store } from "../store/index.js";
import { oracleVerdict, type PairRecord } from "./pairs.js";
import { SEEDS } from "./seeds.js";

/** How a trial reaches Polish: the in-process daemon in tests and in the live tier alike. */
export interface TrialDriver {
  store: Store;
  startRun(projectDir: string, mission: string): Promise<string>;
  waitForTerminal(runId: string): Promise<Run>;
}

export interface TrialOptions {
  experimentId: string;
  arm: string;
  /** Where the trial's project repository is created; kept for inspection. */
  workDir: string;
}

/** The mission both sides of a pair get: the correct side needs nothing, the defect side a fix. */
export function pairMission(pair: Pick<PairRecord, "module" | "behavior">): string {
  return `In src/${pair.module}, ${pair.behavior}. Make sure the code does this; fix it if it does not, and change nothing else.`;
}

/** Run one side of a pair through Polish, judge the run's final code by the pair's oracle, record it. */
export async function runPairSide(driver: TrialDriver, pair: PairRecord, side: "correct" | "defect", options: TrialOptions): Promise<ExperimentTrial> {
  const projectDir = join(options.workDir, `${pair.id}-${side}`);
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(options.workDir, { recursive: true });
  cpSync(side === "correct" ? pair.correctDir : pair.defectDir, projectDir, { recursive: true });
  const git = await Git.init(projectDir);
  await git.commitAll(`pair ${pair.id} ${side}`);

  const runId = await driver.startRun(projectDir, pairMission(pair));
  const run = await driver.waitForTerminal(runId);
  const trial = ExperimentTrialSchema.parse({
    experimentId: options.experimentId,
    arm: options.arm,
    pairId: pair.id,
    side,
    runId,
    phase: run.phase,
    terminalCode: run.terminalReason?.code ?? null,
    ...findingCounts(driver.store, runId),
    oraclePassed: await oracleOnBranch(git, run.runBranch, pair),
    tokens: tokensOf(driver.store, runId),
  });
  driver.store.events.append([{
    id: id("evt", Date.now()),
    runId,
    ts: Date.now(),
    type: EXPERIMENT_TRIAL_EVENT,
    payload: { trial },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
  return trial;
}

function findingCounts(store: Store, runId: string): Pick<ExperimentTrial, "demonstratedBlocking" | "examined" | "validated"> {
  let demonstratedBlocking = 0;
  let examined = 0;
  let validated = 0;
  for (const finding of store.repos.findings.listByRun(runId)) {
    if (finding.blocking && (finding.status === "VALID" || finding.status === "RESOLVED")) demonstratedBlocking += 1;
    const validations = store.repos.validations.listByFinding(finding.id);
    if (validations.length > 0) validated += 1;
    if (validations.some((validation) => validation.outcome === "demonstrated" || validation.outcome === "refuted")) examined += 1;
  }
  return { demonstratedBlocking, examined, validated };
}

/** The oracle on a detached checkout of the run branch; null when the branch cannot be checked out. */
async function oracleOnBranch(git: Git, branch: string, pair: PairRecord): Promise<boolean | null> {
  const seed = SEEDS.find((item) => item.id === pair.seed);
  if (seed === undefined) return null;
  const dir = join(mkdtempSync(join(tmpdir(), "polish-oracle-")), "tree");
  try {
    await git.worktreeAdd(dir, branch, { detach: true });
  } catch {
    return null;
  }
  try {
    return oracleVerdict(dir, seed).passed;
  } finally {
    await git.out(["worktree", "remove", "--force", dir]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

function tokensOf(store: Store, runId: string): number {
  let tokens = 0;
  for (const event of store.events.list(runId, { types: ["model.call"] })) {
    const usage = event.payload["usage"] as { inputTokens?: unknown; outputTokens?: unknown } | null | undefined;
    if (typeof usage?.inputTokens === "number") tokens += usage.inputTokens;
    if (typeof usage?.outputTokens === "number") tokens += usage.outputTokens;
  }
  return tokens;
}
