import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderError } from "../broker/types.js";
import { DaemonService } from "../daemon/service.js";
import type { Run } from "../domain/run.js";
import { reply, type ScriptedProvider, type ScriptStep } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { Git } from "../sandbox/git.js";

export const FIXTURES = resolve(fileURLToPath(new URL("../../fixtures/", import.meta.url)));

const TERMINAL = new Set(["DONE", "NEEDS_HUMAN", "FAILED"]);

export interface ScenarioEnv {
  dir: string;
  repoDir: string;
  home: string;
  clock: FakeClock;
  service: DaemonService;
  provider: ScriptedProvider;
}

export function destroyScenario(env: ScenarioEnv | undefined): Promise<void> {
  if (env === undefined) return Promise.resolve();
  return env.service.close().finally(() => {
    rmSync(env.dir, { recursive: true, force: true });
  });
}

export async function startScenario(fixture: string): Promise<ScenarioEnv> {
  const dir = mkdtempSync(join(tmpdir(), "polish-scenario-"));
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  cpSync(join(FIXTURES, fixture), repoDir, { recursive: true });
  const git = await Git.init(repoDir);
  await git.commitAll(`init ${fixture}`);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "polish.toml"), TOML);
  const clock = new FakeClock(1_700_000_000_000);
  const service = new DaemonService({ home, clock, tickMs: 1, requiredCleanRounds: 1 });
  const provider = service.productionComposition().providers[0] as ScriptedProvider;
  return { dir, repoDir, home, clock, service, provider };
}

export async function drive(env: ScenarioEnv, runId: string, maxTicks: number): Promise<{ run: Run; ticks: number }> {
  for (let ticks = 0; ticks < maxTicks; ticks += 1) {
    const run = env.service.store.repos.runs.get(runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    if (TERMINAL.has(run.phase)) return { run, ticks };
    const pending = env.service.engine.tickRun(runId);
    // Retries sleep on the fake clock. Advancing it is what lets a tick finish; a tick that
    // ignores the clock still has to return, or this rejects instead of hanging the suite.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`tick ${String(ticks)} hung in ${run.phase}`)); }, 8_000);
    });
    try {
      await Promise.race([Promise.all([pending, env.clock.advance(30_000)]), hung]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    await pending;
  }
  const run = env.service.store.repos.runs.get(runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  return { run, ticks: maxTicks };
}

export function workerTokens(env: ScenarioEnv, runId: string): number {
  let tokens = 0;
  for (const event of env.service.store.events.list(runId, { types: ["model.call"] })) {
    if (event.payload["purpose"] !== "agent_run") continue;
    const usage = event.payload["usage"];
    if (typeof usage !== "object" || usage === null) continue;
    const record = usage as { inputTokens?: unknown; outputTokens?: unknown };
    tokens += typeof record.inputTokens === "number" ? record.inputTokens : 0;
    tokens += typeof record.outputTokens === "number" ? record.outputTokens : 0;
  }
  return tokens;
}

export function loadTranscript(name: string): { name: string; arguments: Record<string, unknown> }[] {
  const parsed = JSON.parse(readFileSync(join(FIXTURES, "transcripts", name), "utf8")) as {
    calls: { name: string; arguments: Record<string, unknown> }[];
  };
  return parsed.calls;
}

export function toolSteps(calls: readonly { name: string; arguments: Record<string, unknown> }[]): ScriptStep[] {
  return calls.map((call, index) => ({
    kind: "reply" as const,
    content: "",
    toolCalls: [{ id: `t${String(index)}`, name: call.name, arguments: JSON.stringify(call.arguments) }],
  }));
}

export function scriptPipeline(provider: ScriptedProvider, worker: ScriptStep[], review: ScriptStep[]): void {
  provider.script("wkr", [
    opinion(plannerIntake()),
    opinion(supervisorApprove()),
    opinion(judgeApprove()),
    { kind: "reply", content: "", toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }] },
    { kind: "reply", content: '{"probe":"ok"}' },
    opinion(plannerDecompose()),
    opinion(supervisorApprove({ dropRefs: [] })),
    opinion(judgeApprove({ restoreRefs: [] })),
    ...worker,
    ...review,
  ]);
}

export function emptyReview(count = 8): ScriptStep[] {
  return Array.from({ length: count }, () => ({
    kind: "fn" as const,
    fn: (request: { messages: unknown }) => reply(
      JSON.stringify({
        findings: JSON.stringify(request.messages).includes("evictStale")
          ? [{
            criterion: "correctness",
            severity: "high",
            blocking: false,
            claim: "evictStale reads one past the end",
            evidence: [{ path: "src/cache.ts", line: 8 }],
            reproduction: ["call evictStale([], 0)"],
          }]
          : [],
      }),
      10,
      5,
    ),
  }));
}

export function accountLimit(error: ProviderError, count: number): ScriptStep[] {
  return Array.from({ length: count }, () => ({ kind: "error" as const, error }));
}

export const FIXED_ADD = `import { pad } from "pad";

export function add(a, b) {
  return pad(a + b);
}
`;

const TOML = `
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

[retry]
maxAttempts = 2

[budget]
maxRunWallClockMinutes = 60
maxTaskTokens = 96000

[runtimeValidation]
mode = "auto"
`;

function opinion(content: string): ScriptStep {
  return { kind: "reply", content };
}

function plannerIntake(): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "The mission names a checkable change.",
    concerns: [],
    proposal: {
      goals: ["Make the tests pass"],
      requirements: [{
        ref: "R1",
        statement: "The exported add function agrees with its test",
        acceptance: ["node --test passes"],
        blocking: true,
      }],
      constraints: [],
      nonGoals: [],
      definitionOfSuccess: ["tests pass"],
      ambiguities: [],
    },
  });
}

function supervisorApprove(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ decision: "approve", rationale: "In scope.", concerns: [], proposal: extra });
}

function judgeApprove(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ decision: "approve", rationale: "Testable.", concerns: [], proposal: extra });
}

function plannerDecompose(): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "One task.",
    concerns: [],
    proposal: [{
      title: "Fix add",
      description: "WHAT: make add agree with its test\nWHY: the test is the mission\nCONSTRAINTS: keep the pad import\nEVIDENCE: tests/add.test.mjs",
      kind: "bugfix",
      requirementRef: "R1",
      acceptance: ["node --test passes"],
      complexity: "trivial",
      dependsOn: [],
    }],
  });
}

export function fixtureTestFails(repoDir: string): boolean {
  try {
    execSync("node --test tests/add.test.mjs", { cwd: repoDir, stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
}
