/**
 * B10 daemon path — production entrypoint E2E on resume-dup-fetch fixture.
 *
 * Same happy-path evidence as engine-level B10, but via DaemonService.handle("run")
 * with config-loaded ScriptedProvider (no test-body catalog.discover(), no providers override).
 */

import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { DaemonService } from "../daemon/service.js";

// ---------------------------------------------------------------------------
// Council JSON helpers (from b10.test.ts)
// ---------------------------------------------------------------------------

function plannerIntake(): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "Clear bugfix with deterministic acceptance criteria.",
    concerns: [],
    proposal: {
      goals: ["Fix duplicate request after resume"],
      requirements: [
        {
          ref: "R1",
          statement: "Clear #pending flag before retry to prevent duplicate in-flight detection",
          acceptance: ["retries after transient failure succeed", "test suite passes"],
          blocking: false,
        },
      ],
      constraints: ["Preserve existing retry logic"],
      nonGoals: [],
      definitionOfSuccess: ["all tests pass after fix"],
      ambiguities: [],
    },
  });
}

function supervisorApprove(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "Scope is appropriate.",
    concerns: [],
    proposal: extra,
  });
}

function judgeApprove(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "Task plan is complete and testable.",
    concerns: [],
    proposal: extra,
  });
}

function plannerDecompose(): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "Single coding task covers the requirement.",
    concerns: [],
    proposal: [
      {
        title: "Fix duplicate in-flight detection on retry",
        description:
          "WHAT: Clear #pending flag before retry\nWHY: Prevents duplicate in-flight detection on resume\nCONSTRAINTS: Preserve retry count logic\nEVIDENCE: mission interpretation",
        kind: "bugfix",
        requirementRef: "R1",
        acceptance: ["retries after transient failure succeed", "test suite passes"],
        complexity: "trivial",
        dependsOn: [],
      },
    ],
  });
}

const FIXED_SOURCE = `/**
 * retryFetch – fixed implementation.
 */
export class RetryFetcher {
  #pending = false;

  constructor(fetchFn, maxRetries = 2) {
    this.fetchFn = fetchFn;
    this.maxRetries = maxRetries;
  }

  async fetch(url) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.#pending) {
        throw new Error("duplicate in-flight request detected");
      }
      this.#pending = true;
      try {
        const result = await this.fetchFn(url);
        this.#pending = false;
        return result;
      } catch (err) {
        this.#pending = false; // FIX: clear before retry
        lastError = err;
      }
    }
    throw lastError;
  }
}
`;

const FIXTURE_SRC = resolve(
  new URL(import.meta.url).pathname,
  "../../..",
  "fixtures/resume-dup-fetch",
);

function opinion(content: string) {
  return { kind: "reply" as const, content };
}

// ---------------------------------------------------------------------------
// Fixture env (from b10.test.ts makeEnv)
// ---------------------------------------------------------------------------

interface TestEnv {
  dir: string;
  repoDir: string;
  home: string;
  clock: FakeClock;
}

async function makeEnv(): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "polish-b10-daemon-"));
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execSync(`cp -r "${FIXTURE_SRC}/." "${repoDir}"`, { stdio: "ignore" });
  const git = await Git.init(repoDir);
  await git.commitAll("init: fixture with duplicate-fetch bug");

  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  // Single scripted model for pinned council + worker/reviewer (router has no alternative).
  writeFileSync(
    join(home, "polish.toml"),
    `
[[providers]]
id = "scripted"
kind = "scripted"
enabled = true
models = ["wkr"]

[[supervisors]]
role = "planner"
model = "scripted:wkr"

[[supervisors]]
role = "scope_guardian"
model = "scripted:wkr"

[[supervisors]]
role = "judge"
model = "scripted:wkr"

[candidates]
trivial = 1
normal = 1
complex = 1

[review]
reviewersPerRound = 1
rotateEnsembles = false
minQualityForRotation = 0

[convergence]
requiredCleanRounds = 1
maxInvestigationRoundsPerFinding = 0
noProgressAttempts = 2

[retry]
maxAttempts = 5

[budget]
maxRunWallClockMinutes = 60

[runtimeValidation]
mode = "auto"
`,
  );

  const clock = new FakeClock(1_700_000_000_000);
  return { dir, repoDir, home, clock };
}

function destroyEnv(env: TestEnv): void {
  rmSync(env.dir, { recursive: true, force: true });
}

async function driveToTerminal(
  service: DaemonService,
  runId: string,
  maxTicks = 300,
): Promise<void> {
  const TERMINAL = new Set(["DONE", "NEEDS_HUMAN", "FAILED"]);
  for (let i = 0; i < maxTicks; i++) {
    const run = service.store.repos.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (TERMINAL.has(run.phase)) return;
    await service.engine.tickRun(runId);
  }
  const run = service.store.repos.runs.get(runId)!;
  throw new Error(`run did not reach terminal after ${maxTicks} ticks; last phase=${run.phase}`);
}

async function driveToPhase(
  service: DaemonService,
  runId: string,
  phase: string,
  maxTicks = 100,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const run = service.store.repos.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.phase === phase) return;
    await service.engine.tickRun(runId);
  }
  throw new Error(`run did not reach ${phase}; last=${service.store.repos.runs.get(runId)?.phase}`);
}

function assertCausality(service: DaemonService, runId: string): void {
  const events = service.store.events.list(runId);
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const event of events) {
    for (const causeId of event.causedBy) {
      expect(byId.get(causeId)?.runId, `${event.type} -> ${causeId}`).toBe(runId);
    }
  }
}

async function assertNoWorktrees(service: DaemonService, env: TestEnv, runId: string): Promise<void> {
  const sandbox = new WorktreeSandbox(
    env.repoDir,
    join(env.home, "worktrees", runId),
    service.getConfig().sandbox,
  );
  expect(await sandbox.list()).toEqual([]);
}

/**
 * Script wkr in execution order (mirrors b10.test.ts batching on one model).
 * Parallel council calls consume sequential entries from the same model queue.
 */
function scriptProvider(provider: ScriptedProvider): void {
  // INTERPRETING_MISSION — 3 parallel council calls to wkr.
  provider.script("wkr", [
    opinion(plannerIntake()),
    opinion(supervisorApprove()),
    opinion(judgeApprove()),
  ]);

  // DISCOVERING_MODELS — capability probes.
  provider.script("wkr", [
    {
      kind: "reply",
      content: "",
      toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }],
    },
    { kind: "reply", content: '{"probe":"ok"}' },
  ]);

  // PLANNING — 3 parallel decompose calls to wkr.
  provider.script("wkr", [
    opinion(plannerDecompose()),
    opinion(supervisorApprove({ dropRefs: [] })),
    opinion(judgeApprove({ restoreRefs: [] })),
  ]);

  // Worker — real fixture fix (same patch as engine B10).
  provider.script("wkr", [
    {
      kind: "reply",
      content: "",
      toolCalls: [{
        id: "t1",
        name: "write",
        arguments: JSON.stringify({ path: "src/retryFetch.mjs", content: FIXED_SOURCE }),
      }],
    },
    {
      kind: "reply",
      content: "",
      toolCalls: [{ id: "t2", name: "finish", arguments: JSON.stringify({ summary: "Fixed #pending not cleared before retry" }) }],
    },
  ]);

  // Review — 1 reviewer, clean round.
  provider.script("wkr", [
    { kind: "reply", content: JSON.stringify({ findings: [] }) },
  ]);
}

function scriptHumanThenDone(provider: ScriptedProvider): void {
  provider.script("wkr", [
    opinion(plannerIntake()),
    opinion(supervisorApprove()),
    opinion(judgeApprove()),
    {
      kind: "reply",
      content: "",
      toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }],
    },
    { kind: "reply", content: '{"probe":"ok"}' },
    opinion(plannerDecompose()),
    opinion(JSON.stringify({
      decision: "needs_human",
      rationale: "Need an explicit compatibility decision.",
      concerns: ["Confirm that the public API must remain compatible."],
      proposal: { dropRefs: [] },
    })),
    opinion(judgeApprove({ restoreRefs: [] })),
    opinion(plannerDecompose()),
    opinion(supervisorApprove({ dropRefs: [] })),
    opinion(judgeApprove({ restoreRefs: [] })),
    {
      kind: "reply",
      content: "",
      toolCalls: [{
        id: "t1",
        name: "write",
        arguments: JSON.stringify({ path: "src/retryFetch.mjs", content: FIXED_SOURCE }),
      }],
    },
    {
      kind: "reply",
      content: "",
      toolCalls: [{ id: "t2", name: "finish", arguments: JSON.stringify({ summary: "Fixed #pending" }) }],
    },
    { kind: "reply", content: JSON.stringify({ findings: [] }) },
  ]);
}

function scriptUntilBlockingWorker(provider: ScriptedProvider): void {
  provider.script("wkr", [
    opinion(plannerIntake()),
    opinion(supervisorApprove()),
    opinion(judgeApprove()),
    {
      kind: "reply",
      content: "",
      toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }],
    },
    { kind: "reply", content: '{"probe":"ok"}' },
    opinion(plannerDecompose()),
    opinion(supervisorApprove({ dropRefs: [] })),
    opinion(judgeApprove({ restoreRefs: [] })),
    {
      kind: "fn",
      fn: (request) => new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(new Error("worker aborted by stop"));
        }, { once: true });
      }),
    },
  ]);
}

// ---------------------------------------------------------------------------
// B10 daemon happy path
// ---------------------------------------------------------------------------

describe("B10 daemon path – production RPC E2E", () => {
  let env: TestEnv;
  let service: DaemonService | undefined;

  beforeEach(async () => {
    env = await makeEnv();
    service = undefined;
  });

  afterEach(async () => {
    await service?.close();
    destroyEnv(env);
  });

  it("runs full production pipeline via DaemonService.handle to DONE", async () => {
    const { repoDir, home, clock } = env;

    expect(
      () => execSync("node --test tests/retryFetch.test.mjs", { cwd: repoDir, stdio: "pipe" }),
      "fixture: bug must be present before run",
    ).toThrow();

    const head = await new Git(repoDir).revParse("HEAD");

    service = new DaemonService({ home, clock, tickMs: 1, requiredCleanRounds: 1 });
    expect(service.productionComposition().providers.map((p) => p.id)).toEqual(["scripted"]);

    const provider = service.productionComposition().providers[0] as ScriptedProvider;
    scriptProvider(provider);

    const created = await service.handle("run", {
      project: repoDir,
      mission: "Fix duplicate request after resume: clear #pending before retry",
      runtime: "auto",
    });
    const runId = (created as { id: string }).id;

    await driveToTerminal(service, runId);

    const finalRun = service.store.repos.runs.get(runId)!;
    const store = service.store;

    // project.discovered
    const discovered = store.events.list(runId, { types: ["project.discovered"] });
    expect(discovered).toHaveLength(1);
    const discoveryPayload = discovered[0]!.payload as { profile?: { projectPath?: string } };
    expect(discoveryPayload.profile?.projectPath).toBe(repoDir);

    // baseline.snapshotted
    const baselines = store.repos.baselines.listByRun(runId);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.commitHash).toBe(head);
    expect(store.events.list(runId, { types: ["baseline.snapshotted"] })).toHaveLength(1);

    // mission.interpreted
    expect(store.events.list(runId, { types: ["mission.interpreted"] })).toHaveLength(1);
    expect(finalRun.interpretationId).not.toBeNull();
    const interpretation = store.repos.interpretations.get(finalRun.interpretationId!);
    expect(interpretation?.requirements.length).toBeGreaterThan(0);

    // coding task.created
    const tasks = store.repos.tasks.listByRun(runId);
    const codingTasks = tasks.filter((t) => t.touchesProductCode);
    expect(codingTasks.length).toBeGreaterThan(0);

    // candidate with real worker commit
    const candidates = store.repos.candidates.listByRun(runId);
    expect(candidates.length).toBeGreaterThan(0);
    const withCommit = candidates.filter((c) => c.headCommit !== null);
    expect(withCommit.length).toBeGreaterThan(0);
    const candidateCommit = withCommit[0]!.headCommit!;
    expect(await new Git(repoDir).revParse(candidateCommit).catch(() => null)).not.toBeNull();

    // gates ran
    expect(candidates.filter((c) => c.gateReport !== null).length).toBeGreaterThan(0);

    // integration advanced checkpoint ≠ baseline
    expect(finalRun.currentCheckpointHash).not.toBeNull();
    expect(finalRun.currentCheckpointHash).not.toBe(head);

    // review execution(s) on integrated checkpoint
    const reviewExecutions = store.repos.reviewExecutions.listByRun(runId);
    expect(reviewExecutions.length).toBeGreaterThan(0);
    const integratedCommit = finalRun.currentCheckpointHash!;
    expect(reviewExecutions.filter((re) => re.checkpointHash === integratedCommit).length).toBeGreaterThan(0);

    // clean round via production convergence (not hand-inserted)
    const cleanRounds = store.repos.cleanRounds.listByRun(runId);
    expect(cleanRounds.length).toBeGreaterThan(0);
    expect(cleanRounds[0]!.checkpointHash).toBe(integratedCommit);

    // source actually changed vs baseline
    const integratedSource = execSync(
      `git show ${integratedCommit}:src/retryFetch.mjs`,
      { cwd: repoDir, encoding: "utf8" },
    );
    expect(integratedSource).toContain("this.#pending = false; // FIX:");

    // terminal DONE
    expect(finalRun.phase).toBe("DONE");
  });

  it("answers NEEDS_HUMAN through RPC and resumes the requesting phase to DONE", async () => {
    const { repoDir, home, clock } = env;
    service = new DaemonService({ home, clock, tickMs: 1, requiredCleanRounds: 1 });
    const provider = service.productionComposition().providers[0] as ScriptedProvider;
    scriptHumanThenDone(provider);

    const created = await service.handle("run", {
      project: repoDir,
      mission: "Fix duplicate request after resume: clear #pending before retry",
      runtime: "auto",
    });
    const runId = (created as { id: string }).id;
    await driveToPhase(service, runId, "NEEDS_HUMAN");
    expect(service.store.repos.runs.get(runId)?.phase).toBe("NEEDS_HUMAN");
    const originalDeadline = service.store.repos.jobs.listByRun(runId)
      .find((job) => job.type === "budget.evaluate")?.dueAt;

    await service.handle("answer", {
      runId,
      answer: "Preserve the public API exactly.",
    });
    const resumedDeadlines = service.store.repos.jobs.listByRun(runId)
      .filter((job) => job.type === "budget.evaluate" && job.state !== "CANCELLED");
    expect(resumedDeadlines).toHaveLength(1);
    expect(resumedDeadlines[0]?.dueAt).toBe(originalDeadline);
    const resumedCouncilCalls = provider.calls
      .filter((call) => call.metadata.purpose.startsWith("council_decompose_"))
      .slice(-3);
    expect(resumedCouncilCalls).toHaveLength(3);
    expect(resumedCouncilCalls.every((call) =>
      call.messages.some((message) => message.content.includes("Preserve the public API exactly."))))
      .toBe(true);
    await driveToTerminal(service, runId);

    expect(service.store.repos.runs.get(runId)?.phase).toBe("DONE");
    const answers = service.store.events.list(runId, { types: ["run.answer_recorded"] });
    expect(answers).toHaveLength(1);
    expect(answers[0]?.actor.kind).toBe("user");
    const reopening = service.store.events.list(runId, { types: ["run.phase_changed"] })
      .find((event) => event.causedBy.includes(answers[0]!.id));
    expect((reopening?.payload["run"] as { phase?: string } | undefined)?.phase)
      .toBe("PLANNING");
    expect(readFileSync(join(home, "runs", runId, "answers.jsonl"), "utf8"))
      .toContain("Preserve the public API exactly.");
    assertCausality(service, runId);
    await assertNoWorktrees(service, env, runId);
  });

  it("stops in EXECUTING and resumes without dispatching inside the resume RPC", async () => {
    const { repoDir, home, clock } = env;
    service = new DaemonService({ home, clock, tickMs: 1, requiredCleanRounds: 1 });
    const provider = service.productionComposition().providers[0] as ScriptedProvider;
    scriptUntilBlockingWorker(provider);
    const created = await service.handle("run", {
      project: repoDir,
      mission: "Fix duplicate request after resume: clear #pending before retry",
      runtime: "auto",
    });
    const runId = (created as { id: string }).id;
    await driveToPhase(service, runId, "EXECUTING");
    const spentBeforeStop = service.productionComposition().broker.budgetSnapshot(runId).runTokens;
    const originalDeadline = service.store.repos.jobs.listByRun(runId)
      .find((job) => job.type === "budget.evaluate")?.dueAt;
    expect(originalDeadline).toBeTypeOf("number");

    const executing = service.engine.tickRun(runId);
    for (let i = 0; i < 100 && !provider.calls.some((call) => call.metadata.purpose === "agent_run"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(provider.calls.some((call) => call.metadata.purpose === "agent_run")).toBe(true);

    const stopped = await service.handle("stop", { runId }) as {
      phase: string;
      control: string;
      terminalReason: { code: string } | null;
    };
    await executing;
    expect(stopped).toMatchObject({
      phase: "EXECUTING",
      control: "STOPPED",
      terminalReason: { code: "stopped_by_user" },
    });
    expect(service.store.repos.candidates.listByRun(runId)).toEqual([]);
    await service.close();
    service = undefined;
    service = new DaemonService({ home, clock, tickMs: 1, requiredCleanRounds: 1 });
    expect(service.productionComposition().broker.budgetSnapshot(runId).runTokens).toBe(spentBeforeStop);

    const resumed = await service.handle("resume", { runId }) as {
      phase: string;
      control: string;
      terminalReason: unknown;
    };
    expect(resumed).toEqual(expect.objectContaining({
      phase: "EXECUTING",
      control: "RUNNING",
      terminalReason: null,
    }));
    expect(service.store.repos.candidates.listByRun(runId)).toEqual([]);
    const resumedDeadline = service.store.repos.jobs.listByRun(runId)
      .filter((job) => job.type === "budget.evaluate" && job.state !== "CANCELLED");
    expect(resumedDeadline).toHaveLength(1);
    expect(resumedDeadline[0]?.dueAt).toBe(originalDeadline);
    assertCausality(service, runId);
    await assertNoWorktrees(service, env, runId);
  });

  it("recovers an EXECUTING run, its jobs, and non-zero spend in a fresh service", async () => {
    const { repoDir, home, clock } = env;
    service = new DaemonService({ home, clock, tickMs: 1, requiredCleanRounds: 1 });
    scriptProvider(service.productionComposition().providers[0] as ScriptedProvider);
    const created = await service.handle("run", {
      project: repoDir,
      mission: "Fix duplicate request after resume: clear #pending before retry",
      runtime: "auto",
    });
    const runId = (created as { id: string }).id;
    await driveToPhase(service, runId, "EXECUTING");
    const beforePhase = service.store.repos.runs.get(runId)!.phase;
    const beforeJobs = service.store.repos.jobs.listByRun(runId).map((job) => job.id).sort();
    expect(service.productionComposition().broker.budgetSnapshot(runId).runTokens).toBeGreaterThan(0);

    await service.close();
    service = undefined;
    service = new DaemonService({ home, clock, tickMs: 1, requiredCleanRounds: 1 });

    expect(service.store.repos.runs.get(runId)?.phase).toBe(beforePhase);
    expect(service.store.repos.jobs.listByRun(runId).map((job) => job.id).sort()).toEqual(beforeJobs);
    expect(service.productionComposition().broker.budgetSnapshot(runId).runTokens).toBeGreaterThan(0);
    assertCausality(service, runId);
    await assertNoWorktrees(service, env, runId);
  });
});
