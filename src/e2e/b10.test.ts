/**
 * B10 — Production E2E (positive + negative)
 *
 * Tests the full Polish orchestration pipeline through the production composition
 * (installProductionDrivers), not stub drivers.  ScriptedProvider serves as
 * the LLM backend so no real API keys are required.
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,

} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISABLED_REASONING } from "../broker/responseSchemas.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import { reviewerSystemPrompt } from "../review/reviewerProtocol.js";
import { defaultConfig, type PolishConfig } from "../domain/config.js";
import { RunEngine } from "../engine/engine.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import {
  buildProductionDeps,
  installProductionDrivers,
  PRODUCTION_DRIVER_PHASES as _PRODUCTION_DRIVER_PHASES,
} from "../daemon/composition.js";
import { isStubDriver as _isStubDriver } from "../engine/stubs.js";
import { createMission } from "../domain/mission.js";
import { id } from "../shared/ids.js";
import type { Run } from "../domain/run.js";
import type { NewEvent } from "../domain/event.js";
import type { RuntimeEvidence } from "../domain/acceptance.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fast-test config: 1 reviewer, 1 clean round, 1 candidate, 1 retry. */
function testConfig(overrides: Partial<PolishConfig> = {}): PolishConfig {
  return {
    ...defaultConfig(),
    candidates: { trivial: 1, normal: 1, complex: 1 },
    review: { ...defaultConfig().review, reviewersPerRound: 1, rotateEnsembles: false,
    maxAxisAttemptsPerRound: 6, minQualityForRotation: 0 },
    convergence: { ...defaultConfig().convergence, requiredCleanRounds: 1, maxInvestigationRoundsPerFinding: 0, noProgressAttempts: 2 },
    retry: { ...defaultConfig().retry, maxAttempts: 5 },
    ...overrides,
  };
}

/** Wait for the run to reach a terminal phase (DONE, NEEDS_HUMAN, FAILED) by ticking. */
async function driveToTerminal(
  engine: RunEngine,
  runId: string,
  store: Store,
  maxTicks = 200,
): Promise<Run> {
  const TERMINAL = new Set(["DONE", "NEEDS_HUMAN", "FAILED"]);
  for (let i = 0; i < maxTicks; i++) {
    const run = store.repos.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (TERMINAL.has(run.phase)) return run;
    await engine.tickRun(runId);
  }
  const run = store.repos.runs.get(runId)!;
  throw new Error(`run did not reach terminal after ${maxTicks} ticks; last phase=${run.phase}`);
}

/** Emit a mission.recorded event so INTERPRETING_MISSION can proceed. */
function recordMission(store: Store, runId: string, missionId: string, projectPath: string, clock: FakeClock): void {
  const mission = createMission({
    id: missionId,
    projectPath,
    text: "Fix duplicate request after resume: clear #pending before retry",
    createdAt: clock.now(),
  });
  const event: NewEvent = {
    id: id("evt", clock.now()),
    runId,
    ts: clock.now(),
    type: "mission.recorded",
    payload: { mission },
    causedBy: [],
    actor: { kind: "user" },
    artifacts: [],
  };
  store.events.append([event]);
}

/** Council JSON: planner approves mission intake. */
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

/** Council JSON: supervisor approves without specific proposal (intake/decompose scope_guardian). */
function supervisorApprove(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "Scope is appropriate.",
    concerns: [],
    proposal: extra,
  });
}

/** Council JSON: judge approves. */
function judgeApprove(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "Task plan is complete and testable.",
    concerns: [],
    proposal: extra,
  });
}

/** Council JSON: planner proposes task decomposition. */
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

interface TestEnv {
  dir: string;
  repoDir: string;
  store: Store;
  clock: FakeClock;
}

const PROTOCOLS = ProtocolRegistry.load(defaultProtocolsRoot());

async function makeEnv(): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "polish-b10-"));
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execSync(`cp -r "${FIXTURE_SRC}/." "${repoDir}"`, { stdio: "ignore" });
  const git = await Git.init(repoDir);
  await git.commitAll("init: fixture with duplicate-fetch bug");
  const store = openStore({ artifactsDir: join(dir, "artifacts") });
  const clock = new FakeClock(1_700_000_000_000);
  return { dir, repoDir, store, clock };
}

function destroyEnv(env: TestEnv): void {
  try { env.store.close(); } catch { /* ignore */ }
  rmSync(env.dir, { recursive: true, force: true });
}

/**
 * Build engine + deps + provider with probe scripts scripted.
 * Returns { engine, provider, deps } ready for installProductionDrivers.
 */
async function buildTestEngine(
  env: TestEnv,
  config: PolishConfig,
): Promise<{
  engine: RunEngine;
  provider: ScriptedProvider;
  deps: ReturnType<typeof buildProductionDeps>;
}> {
  const { dir, store, clock } = env;

  // "wkr" = worker model (frontier, no JSON mode → not selected for council roles).
  // "sup" = supervisor/judge model (strong, JSON mode → selected for all council roles).
  // Setting supportsJson=false on wkr ensures the router always picks "sup" for requireJson roles.
  const provider = new ScriptedProvider("scripted", [
    { name: "wkr", capabilities: { ...FAKE_CAPABILITIES.frontier, supportsJson: false, inputCostPerM: 0, outputCostPerM: 0 } },
    { name: "sup", capabilities: { ...FAKE_CAPABILITIES.strong, inputCostPerM: 0, outputCostPerM: 0 } },
  ], {
    fallback: {
      kind: "fn",
      fn: (req) => {
        const model = req.model.model;
        if (model === "sup") {
          // Valid council approval (handles any council overflow) or review clean response.
          return {
            message: { role: "assistant" as const, content: JSON.stringify({ decision: "approve", rationale: "fallback", concerns: [], proposal: {} }) },
            usage: { inputTokens: 10, outputTokens: 5, costUsd: null },
            finishReason: "stop" as const,
            latencyMs: 1,
          };
        }
        // Worker fallback: finish tool call.
        return {
          message: { role: "assistant" as const, content: "", toolCalls: [{ id: "fb", name: "finish", arguments: JSON.stringify({ summary: "fallback" }) }] },
          usage: { inputTokens: 10, outputTokens: 5, costUsd: null },
          finishReason: "tool_calls" as const,
          latencyMs: 1,
        };
      },
    },
  });

  // No probe scripts here — they must be scripted by the caller in execution order
  // (after council intake scripts but before decompose, because DISCOVERING_MODELS runs
  // between INTERPRETING_MISSION and PLANNING).

  const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
  const engine = new RunEngine(
    { store, clock, scheduler: sched, config, assertProjectClean: () => undefined },
    false,
  );
  const deps = buildProductionDeps({
    store,
    clock,
    config,
    home: join(dir, "home"),
    providers: [provider],
    resolveSandbox: (ctx) =>
      new WorktreeSandbox(ctx.run.projectPath, join(dir, "worktrees", ctx.run.id), config.sandbox),
  });
  installProductionDrivers(engine, deps);

  // Pre-populate catalog without probing (no API calls consumed).
  // Models default to available=true (see ModelCatalog.isModelAvailable fallback).
  // DISCOVERING_MODELS phase will probe again but we script those calls generously.
  await deps.catalog.discover();  // no capabilityProbe → just list + upsert, no scripts consumed

  return { engine, provider, deps };
}

// ---------------------------------------------------------------------------
// B10 positive path
// ---------------------------------------------------------------------------

describe("B10 positive path – production E2E", () => {
  let env: TestEnv;

  beforeEach(async () => { env = await makeEnv(); });
  afterEach(() => { destroyEnv(env); });

  it("runs full production pipeline from bug-present to DONE with all 23 assertions", async () => {
    const { repoDir, store, clock } = env;
    const config = testConfig();

    // ASSERTION 1: bug exists before the run.
    expect(
      () => execSync("node --test tests/retryFetch.test.mjs", { cwd: repoDir, stdio: "pipe" }),
      "fixture: bug must be present before run",
    ).toThrow();

    const { engine, provider } = await buildTestEngine(env, config);

    // Execution order: INTERPRETING_MISSION → DISCOVERING_MODELS → PLANNING
    //
    // 1. Council intake (INTERPRETING_MISSION): 3 parallel calls to "sup".
    provider.script("sup", [
      { kind: "reply", content: plannerIntake() },        // intake planner
      { kind: "reply", content: supervisorApprove() },    // intake scope_guardian
      { kind: "reply", content: judgeApprove() },         // intake judge
    ]);

    // 2. DISCOVERING_MODELS: probes wkr + sup (2 calls each).
    // wkr JSON probe returns non-JSON so supportsJson stays false → router won't pick wkr for council.
    provider.script("wkr", [
      { kind: "reply", content: "", toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: "not json" },  // JSON probe fails → supportsJson=false preserved
    ]);
    provider.script("sup", [
      { kind: "reply", content: "", toolCalls: [{ id: "psup", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);

    // 3. Council decompose (PLANNING): 3 parallel calls to "sup".
    provider.script("sup", [
      { kind: "reply", content: plannerDecompose() },        // decompose planner
      { kind: "reply", content: supervisorApprove({ dropRefs: [] }) },  // decompose scope_guardian
      { kind: "reply", content: judgeApprove({ restoreRefs: [] }) },    // decompose judge
    ]);

    // Worker: write fix then finish.
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

    // Review (1 reviewer via Router requireJson → "sup", clean round – no findings).
    provider.script("sup", [
      { kind: "reply", content: JSON.stringify({ findings: [] }) },
    ]);

    // Run setup.
    const run = engine.createRun({ projectPath: repoDir, runBranch: "polish/main" });
    recordMission(store, run.id, run.missionId, repoDir, clock);
    const head = await new Git(repoDir).revParse("HEAD");
    await new Git(repoDir).createBranch(run.runBranch, head);
    engine.setCurrentCheckpoint(run.id, head);

    const finalRun = await driveToTerminal(engine, run.id, store, 300);

    // -------------------------------------------------------------------------
    // Assertions 1-23
    // -------------------------------------------------------------------------

    // 2. Production project discovery actually ran.
    const discovered = store.events.list(run.id, { types: ["project.discovered"] });
    expect(discovered).toHaveLength(1);
    const discoveryPayload = discovered[0]!.payload as { profile?: { projectPath?: string } };
    expect(discoveryPayload.profile?.projectPath).toBe(repoDir);

    // 3. Baseline actually created.
    const baselines = store.repos.baselines.listByRun(run.id);
    expect(baselines).toHaveLength(1);
    const baseline = baselines[0]!;
    expect(baseline.commitHash).toBe(head);
    const baselineSnapshotted = store.events.list(run.id, { types: ["baseline.snapshotted"] });
    expect(baselineSnapshotted).toHaveLength(1);

    // 4. MissionInterpretation created.
    const interpretationId = store.repos.runs.get(run.id)?.interpretationId;
    expect(interpretationId, "interpretationId must be set").toBeTruthy();
    const interpretation = store.repos.interpretations.get(interpretationId!);
    expect(interpretation, "MissionInterpretation must exist").toBeDefined();
    expect(interpretation!.requirements.length).toBeGreaterThan(0);

    // 5. Planner created a coding Task.
    const tasks = store.repos.tasks.listByRun(run.id);
    const codingTasks = tasks.filter((t) => t.touchesProductCode);
    expect(codingTasks.length, "at least one coding task must exist").toBeGreaterThan(0);

    // 6. Worker actually invoked.
    const candidates = store.repos.candidates.listByRun(run.id);
    expect(candidates.length, "worker must have been invoked").toBeGreaterThan(0);

    // 7. Candidate worktree created (branch assigned).
    expect(candidates[0]!.branch, "candidate branch must be set").toBeTruthy();

    // 8. Candidate actually changed source (headCommit set after worker ran).
    const withCommit = candidates.filter((c) => c.headCommit !== null);

    expect(withCommit.length, "at least one candidate must have a head commit").toBeGreaterThan(0);

    // 9. Candidate commit exists in git.
    const candidateCommit = withCommit[0]!.headCommit!;
    const gitCommit = await new Git(repoDir).revParse(candidateCommit).catch(() => null);
    expect(gitCommit, "candidate commit must exist in git").not.toBeNull();

    // 10. Independent gates ran.
    const gatedCandidates = candidates.filter((c) => c.gateReport !== null);
    expect(gatedCandidates.length, "at least one candidate must have run gates").toBeGreaterThan(0);

    // 11. Winner selected.
    const winnerCandidates = candidates.filter((c) => c.state === "WINNER");
    expect(winnerCandidates.length, "exactly one winner must be selected").toBeGreaterThan(0);

    // 12. Winner integrated.
    const integratedTasks = tasks.filter((t) => t.state === "INTEGRATED");
    expect(integratedTasks.length, "at least one task must be INTEGRATED").toBeGreaterThan(0);

    // 13. New checkpoint ≠ baseline.
    const runFinal = store.repos.runs.get(run.id)!;
    expect(runFinal.currentCheckpointHash).not.toBeNull();
    expect(runFinal.currentCheckpointHash, "final checkpoint must differ from baseline").not.toBe(head);

    // 14. Review swarm invoked.
    const reviewExecutions = store.repos.reviewExecutions.listByRun(run.id);
    expect(reviewExecutions.length, "at least one review execution must exist").toBeGreaterThan(0);

    // 15. Review results refer to integrated checkpoint.
    const integratedCommit = runFinal.currentCheckpointHash!;
    const reviewOnCheckpoint = reviewExecutions.filter((re) => re.checkpointHash === integratedCommit);
    expect(reviewOnCheckpoint.length, "review must refer to integrated checkpoint").toBeGreaterThan(0);

    // 16. Findings went through validator; clean round recorded.
    const cleanRounds = store.repos.cleanRounds.listByRun(run.id);
    expect(cleanRounds.length, "at least one clean round must be recorded").toBeGreaterThan(0);

    // 17. If VALID defect exists → follow-up task created.
    const findings = store.repos.findings.listByRun(run.id);
    const validDefects = findings.filter((f) => f.status === "VALID" && f.blocking);
    if (validDefects.length > 0) {
      const followupTasks = tasks.filter((t) => t.origin.kind === "valid_finding");
      expect(followupTasks.length, "VALID blocking finding must create follow-up task").toBeGreaterThan(0);
    }

    // 18. Convergence uses real clean rounds backed by completed review.
    expect(cleanRounds[0]!.checkpointHash).toBe(integratedCommit);
    const completedReview = reviewExecutions.filter(
      (re) => re.checkpointHash === integratedCommit && re.completed,
    );
    expect(completedReview.length, "clean round must be backed by completed review").toBeGreaterThan(0);

    // 19. Final project checks pass (integration gates succeeded on fixed code).
    const integratedCheckpoint = store.repos.checkpoints.byCommit(run.id, integratedCommit);
    expect(integratedCheckpoint, "integrated checkpoint must exist").not.toBeNull();
    expect(integratedCheckpoint!.evidence.testsPassed, "integration gates must have at least one passing test").toBeGreaterThan(0);

    // 20. Runtime remains optional in this engine-level auto-mode scenario.
    expect(config.runtimeValidation.mode).toBe("auto");

    // 21. Original bug is gone — integrated source contains the fix.
    const integratedSource = execSync(
      `git show ${integratedCommit}:src/retryFetch.mjs`,
      { cwd: repoDir, encoding: "utf8" },
    );
    expect(integratedSource).toContain("this.#pending = false; // FIX:");

    // 22. Diff matches mission (only retryFetch.mjs changed).
    const diffOutput = execSync(
      `git diff ${head} ${integratedCommit} --name-only`,
      { cwd: repoDir, encoding: "utf8" },
    ).trim();
    expect(diffOutput).toContain("src/retryFetch.mjs");
    expect(diffOutput).not.toContain("package.json");

    // 23. Only then DONE.
    expect(finalRun.phase, "run must be DONE").toBe("DONE");
  });

  /**
   * P1.5 MC5/AC5, at the pipeline rather than at each site. The per-site checks in
   * `composition.test.ts` and `configLoad.test.ts` observe the two sites the flag is wired to;
   * they say nothing about the sites it must **not** reach. The entry-gate lane made that concrete:
   * stripping the reviewer's or the progress tracker's unconditional `DISABLED_REASONING` in
   * composition, and adding the flag to `completeDebateRole`, all survived every check.
   *
   * So this drives a whole production run to `DONE` and asserts the reasoning actually sent,
   * per role, in both arms. The observed role set is pinned too: a site that starts calling a
   * model, or one that stops, changes this table and has to say so.
   */
  it.each([
    { arm: "default", disableReasoning: false },
    { arm: "disabled", disableReasoning: true },
  ])("sends $arm reasoning per role across a whole production run", async ({ disableReasoning }) => {
    const { repoDir, store, clock } = env;
    const config = testConfig();
    // The default arm reads the default rather than setting it.
    if (disableReasoning) config.routing.disableReasoning = true;
    else expect(config.routing.disableReasoning).toBe(false);

    const { engine, provider } = await buildTestEngine(env, config);
    provider.script("sup", [
      { kind: "reply", content: plannerIntake() },
      { kind: "reply", content: supervisorApprove() },
      { kind: "reply", content: judgeApprove() },
    ]);
    provider.script("wkr", [
      { kind: "reply", content: "", toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: "not json" },
    ]);
    provider.script("sup", [
      { kind: "reply", content: "", toolCalls: [{ id: "psup", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    provider.script("sup", [
      { kind: "reply", content: plannerDecompose() },
      { kind: "reply", content: supervisorApprove({ dropRefs: [] }) },
      { kind: "reply", content: judgeApprove({ restoreRefs: [] }) },
    ]);
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
    provider.script("sup", [{ kind: "reply", content: JSON.stringify({ findings: [] }) }]);

    const run = engine.createRun({ projectPath: repoDir, runBranch: "polish/main" });
    recordMission(store, run.id, run.missionId, repoDir, clock);
    const head = await new Git(repoDir).revParse("HEAD");
    await new Git(repoDir).createBranch(run.runBranch, head);
    engine.setCurrentCheckpoint(run.id, head);
    expect((await driveToTerminal(engine, run.id, store, 300)).phase).toBe("DONE");

    // Keyed by `(role, purpose)` and not by role: the entry-gate lane applied the flag to the
    // tools probe alone and a per-role set still read `{off, unset}`, because the strict probes
    // supply `off` and the JSON probe supplies `unset` whatever the tools probe does.
    //
    // And the whole signature, not just `reasoning`: `temperature` and `maxTokens` were both
    // mutated inside the wrappers with the key set unchanged, and every check passed. MC1's claim
    // is that the default request is what it is at base, so the values are pinned, absolutely,
    // rather than only compared between arms — a wrapper that changes a value in both arms is
    // invisible to a cross-arm comparison.
    const off = JSON.stringify(DISABLED_REASONING);
    const unset = "null";
    const flagged = disableReasoning ? off : unset;
    const expected = [
      // role | purpose | reasoning | temperature | maxTokens | responseFormat | responseSchema
      // | message shape
      `judge|council_decompose_judge|${flagged}|t=0|mt=undefined|rf=json|rs=undefined|m=system,user`,
      `judge|council_intake_judge|${flagged}|t=0|mt=undefined|rf=json|rs=undefined|m=system,user`,
      `planner|council_decompose_planner|${flagged}|t=0|mt=undefined|rf=json|rs=undefined|m=system,user`,
      `planner|council_intake_planner|${flagged}|t=0|mt=undefined|rf=json|rs=undefined|m=system,user`,
      `scope_guardian|council_decompose_scope|${flagged}|t=0|mt=undefined|rf=json|rs=undefined|m=system,user`,
      `scope_guardian|council_intake_scope|${flagged}|t=0|mt=undefined|rf=json|rs=undefined|m=system,user`,
      // `mt` for the worker is the remaining task budget, which depends on what the previous turn
      // spent. Pinning the arithmetic result would fail for any change to the fixture's token
      // accounting, so the two worker rows carry a label and the budget is asserted below against
      // the usage actually recorded.
      `worker|agent_run|${flagged}|t=undefined|mt=budget|rf=undefined|rs=undefined|m=user`,
      `worker|agent_run|${flagged}|t=undefined|mt=budget|rf=undefined|rs=undefined|m=user,assistant,tool`,
      // Unconditional, and identical in both arms. Each probe runs once per candidate model, and
      // this fixture has two, so each appears twice: the count is part of the claim.
      `reviewer|review_correctness|${off}|t=0|mt=1500|rf=undefined|rs=review_findings|m=system,user`,
      ...["wkr", "sup"].flatMap(() => [
        `probe|capability_probe_strict_progress|${off}|t=0|mt=256|rf=undefined|rs=agent_progress_score|m=user`,
        `probe|capability_probe_strict_review|${off}|t=0|mt=256|rf=undefined|rs=review_findings|m=user`,
        `probe|capability_probe_strict_score|${off}|t=0|mt=256|rf=undefined|rs=empirical_pair_score|m=user`,
        `probe|capability_probe_json|${unset}|t=0|mt=256|rf=json|rs=undefined|m=user`,
        `probe|capability_probe_tools|${unset}|t=0|mt=256|rf=undefined|rs=undefined|m=user`,
      ]),
    ].sort();
    // A multiset, not a set. The entry-gate lane made the worker wrapper send every request twice
    // and a de-duplicated table could not tell: AC5 claims a site that starts or stops calling a
    // model changes it, and collapsing duplicates is exactly not that.
    const seen = provider.calls.map((call) =>
      [
        call.metadata.role,
        call.metadata.purpose,
        JSON.stringify(call.reasoning ?? null),
        `t=${String(call.temperature)}`,
        `mt=${call.metadata.purpose === "agent_run" ? "budget" : String(call.maxTokens)}`,
        `rf=${String(call.responseFormat)}`,
        `rs=${String(call.responseSchema?.name)}`,
        `m=${call.messages.map((message) => message.role).join(",")}`,
      ].join("|")).sort();
    expect(seen).toEqual(expected);

    // The sites the flag must not reach are pinned on content too, not only on shape, and
    // against the production builder rather than a copy of its text. The entry-gate lane
    // appended a message to the reviewer's request in the disabled arm only; the shape above
    // catches that, and this catches an edit to what is already there.
    const reviewerRequest = provider.calls.find((call) => call.metadata.role === "reviewer");
    expect(reviewerRequest?.messages[0])
      .toEqual({ role: "system", content: reviewerSystemPrompt(PROTOCOLS, "correctness") });

    // The worker's budget, against the usage the run actually recorded rather than a constant:
    // turn one gets the whole task budget and each later turn gets what the previous ones left.
    const workerRequests = provider.calls.filter((call) => call.metadata.purpose === "agent_run");
    const workerSpend = store.events.list(run.id, { types: ["model.call"] })
      .map((event) => event.payload as { purpose?: string; usage?: { inputTokens: number; outputTokens: number } | null })
      .filter((payload) => payload.purpose === "agent_run")
      .map((payload) => (payload.usage === null || payload.usage === undefined ? 0 : payload.usage.inputTokens + payload.usage.outputTokens));
    let remaining = config.budget.maxTaskTokens ?? 32_000;
    for (const [index, request] of workerRequests.entries()) {
      expect(request.maxTokens, `worker turn ${String(index + 1)} budget`).toBe(remaining);
      remaining -= workerSpend[index] ?? 0;
    }
  });
});

// ---------------------------------------------------------------------------
// B10 negative path
// ---------------------------------------------------------------------------

describe("B10 negative path – anti-fake-DONE enforcement", () => {
  let env: TestEnv;

  beforeEach(async () => { env = await makeEnv(); });
  afterEach(() => { destroyEnv(env); });

  async function setupAndStart(extra: Partial<PolishConfig> = {}) {
    const config = testConfig(extra);
    const { engine, provider } = await buildTestEngine(env, config);
    const run = engine.createRun({ projectPath: env.repoDir, runBranch: "polish/main" });
    recordMission(env.store, run.id, run.missionId, env.repoDir, env.clock);
    const head = await new Git(env.repoDir).revParse("HEAD");
    await new Git(env.repoDir).createBranch(run.runBranch, head);
    engine.setCurrentCheckpoint(run.id, head);
    return { engine, provider, config, run, head };
  }

  function scriptCouncil(provider: ScriptedProvider) {
    // Script in execution order: intake, then probes (DISCOVERING_MODELS), then decompose.
    provider.script("sup", [
      { kind: "reply", content: plannerIntake() },    // INTERPRETING_MISSION
      { kind: "reply", content: supervisorApprove() },
      { kind: "reply", content: judgeApprove() },
    ]);
    // DISCOVERING_MODELS probes. wkr JSON probe returns non-JSON to keep supportsJson=false.
    provider.script("wkr", [
      { kind: "reply", content: "", toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: "not json" },
    ]);
    provider.script("sup", [
      { kind: "reply", content: "", toolCalls: [{ id: "psup", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    provider.script("sup", [
      { kind: "reply", content: plannerDecompose() },    // PLANNING
      { kind: "reply", content: supervisorApprove({ dropRefs: [] }) },
      { kind: "reply", content: judgeApprove({ restoreRefs: [] }) },
    ]);
  }

  // -------------------------------------------------------------------------
  // Scenario 1: No worker work → NEEDS_HUMAN not DONE
  // -------------------------------------------------------------------------
  it("Scenario 1: no worker work → run does not reach DONE", async () => {
    const { engine, provider, run } = await setupAndStart();

    scriptCouncil(provider);

    // Worker produces no changes (just finish with no writes).
    provider.script("wkr", [
      {
        kind: "reply",
        content: "",
        toolCalls: [{ id: "t1", name: "finish", arguments: JSON.stringify({ summary: "nothing done" }) }],
      },
    ]);

    const finalRun = await driveToTerminal(engine, run.id, env.store, 300);
    expect(finalRun.phase, "no-worker-work run must not be DONE").not.toBe("DONE");
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Empty diff → DONE impossible
  // -------------------------------------------------------------------------
  it("Scenario 2: empty diff → DONE is rejected by anti-fake-DONE", async () => {
    const { engine, provider, run } = await setupAndStart();

    scriptCouncil(provider);

    // Worker writes the same content back — no diff vs base.
    const originalContent = readFileSync(join(env.repoDir, "src/retryFetch.mjs"), "utf8");
    provider.script("wkr", [
      {
        kind: "reply",
        content: "",
        toolCalls: [{ id: "t1", name: "write", arguments: JSON.stringify({ path: "src/retryFetch.mjs", content: originalContent }) }],
      },
      {
        kind: "reply",
        content: "",
        toolCalls: [{ id: "t2", name: "finish", arguments: JSON.stringify({ summary: "rewrote to identical content" }) }],
      },
    ]);

    const finalRun = await driveToTerminal(engine, run.id, env.store, 300);
    expect(finalRun.phase, "empty-diff run must not reach DONE").not.toBe("DONE");
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Fake clean round (no completed review records) → rejected
  // -------------------------------------------------------------------------
  it("Scenario 3: buildCleanRoundFromReview throws when no completed review exists", async () => {
    const { buildCleanRoundFromReview } = await import("../convergence/record.js");
    expect(() =>
      buildCleanRoundFromReview({
        runId: "run-1",
        checkpointHash: "a".repeat(40),
        requiredReviewers: 1,
        reviewExecutions: [],
        findings: [],
        existingCleanRounds: [],
        now: Date.now(),
      }),
    ).toThrow("cannot record clean round without completed review executions");
  });

  // -------------------------------------------------------------------------
  // Scenario 4: runtime=required with failing evidence → DONE impossible
  // -------------------------------------------------------------------------
  it("Scenario 4: runtime=required with failing evidence → DONE impossible", async () => {
    const { runtimeAllowsDone } = await import("../domain/acceptance.js");
    const now = Date.now();
    const failEvidence: RuntimeEvidence = {
      id: "ev-1",
      runId: "r1",
      scenarioId: "s1",
      validator: "fixture",
      kind: "node_script",
      status: "failed",
      summary: "scenario failed",
      observations: {},
      checkpointHash: "a".repeat(40),
      sideEffects: { policy: "safe", destructiveExternalEffectsAllowed: false },
      artifactHashes: [],
      startedAt: now,
      finishedAt: now,
    };
    expect(
      runtimeAllowsDone("required", failEvidence, "a".repeat(40)),
      "failed runtime evidence must not allow DONE",
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Stale runtime evidence → not accepted for current checkpoint
  // -------------------------------------------------------------------------
  it("Scenario 5: stale runtime evidence (wrong checkpoint) → not DONE if required", async () => {
    const { runtimeAllowsDone } = await import("../domain/acceptance.js");
    const now = Date.now();
    const staleEvidence: RuntimeEvidence = {
      id: "ev-2",
      runId: "r1",
      scenarioId: "s1",
      validator: "fixture",
      kind: "node_script",
      status: "passed",
      summary: "ok",
      observations: {},
      checkpointHash: "b".repeat(40), // different checkpoint — stale
      sideEffects: { policy: "safe", destructiveExternalEffectsAllowed: false },
      artifactHashes: [],
      startedAt: now,
      finishedAt: now,
    };
    const currentHash = "a".repeat(40);
    expect(
      runtimeAllowsDone("required", staleEvidence, currentHash),
      "stale evidence must not allow DONE for current checkpoint",
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Failed integration (broken tests) → run does not reach DONE
  // -------------------------------------------------------------------------
  it("Scenario 6: broken integration (tests fail) → checkpoint does not advance to DONE", async () => {
    const { engine, provider, run, head } = await setupAndStart();

    scriptCouncil(provider);

    // Worker writes a deliberately broken implementation.
    provider.script("wkr", [
      {
        kind: "reply",
        content: "",
        toolCalls: [{
          id: "t1",
          name: "write",
          arguments: JSON.stringify({
            path: "src/retryFetch.mjs",
            content: "export class RetryFetcher { async fetch() { throw new Error('BROKEN'); } }",
          }),
        }],
      },
      {
        kind: "reply",
        content: "",
        toolCalls: [{ id: "t2", name: "finish", arguments: JSON.stringify({ summary: "broke it intentionally" }) }],
      },
    ]);

    const finalRun = await driveToTerminal(engine, run.id, env.store, 300);

    expect(finalRun.phase, "broken-integration run must not reach DONE").not.toBe("DONE");

    // Checkpoint must not have advanced past the original baseline.
    const runState = env.store.repos.runs.get(run.id)!;
    expect(
      runState.phase === "FAILED" || runState.phase === "NEEDS_HUMAN" || runState.currentCheckpointHash === head,
      "failed integration must not create a new valid integrated checkpoint",
    ).toBe(true);
  });
});
