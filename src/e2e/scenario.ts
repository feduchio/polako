import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderError } from "../broker/types.js";
import { DaemonService } from "../daemon/service.js";
import type { Run } from "../domain/run.js";
import type { CompletionRequest } from "../broker/types.js";
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

export interface ScenarioOptions {
  /**
   * Scripted model names; each is its own family. The default gives the reviewer a family other
   * than the worker's, which a clean round requires.
   */
  models?: string[];
  progressEnabled?: boolean;
  /** `convergence.maxInvestigationRoundsPerFinding`; 0 by default. */
  investigationRounds?: number;
}

export async function startScenario(fixture: string, options: ScenarioOptions = {}): Promise<ScenarioEnv> {
  const dir = mkdtempSync(join(tmpdir(), "polish-scenario-"));
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  cpSync(join(FIXTURES, fixture), repoDir, { recursive: true });
  const git = await Git.init(repoDir);
  await git.commitAll(`init ${fixture}`);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "polish.toml"), scenarioToml(options.models ?? ["wkr", "xrev"], options.progressEnabled ?? false, options.investigationRounds ?? 0));
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

/**
 * `wkr` plans and writes the code. `reviewer` answers the review and the canary: `xrev` by default,
 * `wkr` for a one-model scenario, where REVIEWING has no other family to ask.
 */
export function scriptPipeline(provider: ScriptedProvider, worker: ScriptStep[], review: ScriptStep[], reviewer = "xrev"): void {
  provider.script("wkr", [
    opinion(plannerIntake()),
    opinion(supervisorApprove()),
    opinion(judgeApprove()),
    ...probeSteps("wkr"),
    opinion(plannerDecompose()),
    opinion(supervisorApprove({ dropRefs: [] })),
    opinion(judgeApprove({ restoreRefs: [] })),
    ...worker,
    ...(reviewer === "wkr" ? review : []),
  ]);
  if (reviewer !== "wkr") provider.script(reviewer, [...probeSteps(reviewer), ...review]);
}

function probeSteps(model: string): ScriptStep[] {
  return [
    { kind: "reply", content: "", toolCalls: [{ id: `p${model}`, name: "probe_ping", arguments: "{}" }] },
    { kind: "reply", content: '{"probe":"ok"}' },
  ];
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

function scenarioToml(models: readonly string[], progressEnabled: boolean, investigationRounds: number): string {
  return `
[[providers]]
id = "scripted"
kind = "scripted"
enabled = true
models = ${JSON.stringify(models)}

[agent]
progressEnabled = ${String(progressEnabled)}

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
maxInvestigationRoundsPerFinding = ${String(investigationRounds)}

[retry]
maxAttempts = 2

[budget]
maxRunWallClockMinutes = 60
maxTaskTokens = 96000

[runtimeValidation]
mode = "auto"
`;
}

/** What a scripted model does when asked to work on a task, by which task it is. */
export interface AgentPlan {
  /** Recognises the task from the worker's instruction. */
  matches: (instruction: string) => boolean;
  /** The tool calls, in order; the loop's own tool results decide which one is next. */
  calls: { name: string; arguments: Record<string, unknown> }[];
}

export interface Responders {
  agent: AgentPlan[];
  /** A review answer for a request that is not the seeded-defect canary. */
  review: (request: CompletionRequest) => unknown[];
  debate: (role: string, request: CompletionRequest) => string;
}

/**
 * One responder for every model, answering by what was asked rather than by call order. Which
 * model the router picks for a role depends on probes, families and exclusions; a script in call
 * order breaks the moment that changes, and a script by purpose does not.
 */
export function scriptByPurpose(provider: ScriptedProvider, models: readonly string[], responders: Responders, unknown: string[] = []): void {
  const step: ScriptStep = {
    kind: "fn",
    fn: (request) => {
      const purpose = request.metadata.purpose;
      switch (purpose) {
        case "capability_probe_tools":
          return reply("", 1, 1, null, [{ id: "probe", name: "probe_ping", arguments: "{}" }]);
        case "capability_probe_json":
          return reply('{"probe":"ok"}', 1, 1);
        case "council_intake_planner":
          return reply(plannerIntake(), 10, 5);
        case "council_intake_scope":
        case "council_decompose_scope":
          return reply(supervisorApprove({ dropRefs: [] }), 10, 5);
        case "council_intake_judge":
        case "council_decompose_judge":
          return reply(judgeApprove({ restoreRefs: [] }), 10, 5);
        case "council_decompose_planner":
          return reply(plannerDecompose(), 10, 5);
        case "finding_debate":
          return reply(responders.debate(request.metadata.role, request), 10, 5);
        case "agent_run": {
          const instruction = request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
          const plan = responders.agent.find((candidate) => candidate.matches(instruction));
          if (plan === undefined) {
            unknown.push(`agent_run: ${instruction.slice(0, 120)}`);
            return reply("no plan for this task", 1, 1);
          }
          const done = request.messages.filter((message) => message.role === "tool").length;
          const call = plan.calls[Math.min(done, plan.calls.length - 1)];
          if (call === undefined) return reply("empty plan", 1, 1);
          return reply("", 10, 5, null, [{ id: `c${String(done)}`, name: call.name, arguments: JSON.stringify(call.arguments) }]);
        }
        default:
          if (purpose.startsWith("review_")) {
            const findings = JSON.stringify(request.messages).includes("evictStale")
              ? [{
                criterion: "correctness",
                severity: "high",
                blocking: false,
                claim: "evictStale reads one past the end",
                evidence: [{ path: "src/cache.ts", line: 8 }],
                reproduction: ["call evictStale([], 0)"],
              }]
              : responders.review(request);
            return reply(JSON.stringify({ findings }), 10, 5);
          }
          unknown.push(purpose);
          return reply(JSON.stringify({ decision: "approve", rationale: "ok", concerns: [] }), 1, 1);
      }
    },
  };
  for (const model of models) provider.script(model, Array.from({ length: 400 }, () => step));
}

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
