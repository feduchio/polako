import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { it, expect } from "vitest";
import { defaultConfig } from "../domain/config.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { openStore } from "../store/index.js";
import { buildProductionDeps, installProductionDrivers } from "../daemon/composition.js";
import { RunEngine } from "../engine/engine.js";
import { Scheduler } from "../scheduler/index.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { createMission } from "../domain/mission.js";
import { id } from "../shared/ids.js";
import type { NewEvent } from "../domain/event.js";

it("debug: tracks which scripts are consumed for sup", async () => {
  const FIXTURE = "/Users/fedorsvetlov/polish/fixtures/resume-dup-fetch";
  const dir = mkdtempSync(join(tmpdir(), "b10-d-"));
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execSync(`cp -r "${FIXTURE}/." "${repoDir}"`, { stdio: "ignore" });
  const git = await Git.init(repoDir);
  await git.commitAll("init");
  const store = openStore({ artifactsDir: join(dir, "artifacts") });
  const clock = new FakeClock(1_700_000_000_000);
  const config = { ...defaultConfig(), candidates: { trivial: 1, normal: 1, complex: 1 } };

  const callLog: string[] = [];
  const provider = new ScriptedProvider("scripted", [
    { name: "wkr", capabilities: { ...FAKE_CAPABILITIES.frontier, supportsJson: false } },
    { name: "sup", capabilities: FAKE_CAPABILITIES.strong },
  ], {
    fallback: {
      kind: "fn",
      fn: (req) => {
        const content = JSON.stringify({ decision: "approve", rationale: "fallback", concerns: [], proposal: {} });
        callLog.push(`FALLBACK:${req.model.model}:${req.metadata.purpose}`);
        return { message: { role: "assistant", content }, usage: { inputTokens: 10, outputTokens: 5, costUsd: null }, finishReason: "stop", latencyMs: 1 };
      },
    },
  });

  // Script in execution order
  provider.script("sup", [
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "intake-planner", concerns: [], proposal: { goals: ["fix"], requirements: [{ ref: "R1", statement: "Fix it", acceptance: ["pass"] }], constraints: [], nonGoals: [], definitionOfSuccess: ["pass"], ambiguities: [] } }) },
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "intake-scope", concerns: [], proposal: {} }) },
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "intake-judge", concerns: [], proposal: {} }) },
  ]);
  provider.script("wkr", [
    { kind: "reply", content: "", toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }] },
    { kind: "reply", content: '{"probe":"ok"}' },
  ]);
  provider.script("sup", [
    { kind: "reply", content: "", toolCalls: [{ id: "psup", name: "probe_ping", arguments: "{}" }] },
    { kind: "reply", content: '{"probe":"ok"}' },
  ]);
  provider.script("sup", [
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "decompose-planner", concerns: [], proposal: [{ title: "Fix", description: "WHAT: fix", kind: "bugfix", requirementRef: "R1", acceptance: ["pass"], complexity: "trivial", dependsOn: [] }] }) },
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "decompose-scope", concerns: [], proposal: { dropRefs: [] } }) },
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "decompose-judge", concerns: [], proposal: { restoreRefs: [] } }) },
  ]);

  const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
  const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
  const deps = buildProductionDeps({
    store, clock, config,
    home: join(dir, "home"),
    providers: [provider],
    resolveSandbox: (ctx) => new WorktreeSandbox(ctx.run.projectPath, join(dir, "worktrees", ctx.run.id), config.sandbox),
  });
  installProductionDrivers(engine, deps);
  await deps.catalog.discover();

  const run = engine.createRun({ projectPath: repoDir });
  const mission = createMission({ id: run.missionId, projectPath: repoDir, text: "Fix bug", createdAt: clock.now() });
  const evt: NewEvent = { id: id("evt", clock.now()), runId: run.id, ts: clock.now(), type: "mission.recorded", payload: { mission }, causedBy: [], actor: { kind: "user" }, artifacts: [] };
  store.events.append([evt]);
  const head = await new Git(repoDir).revParse("HEAD");
  await new Git(repoDir).createBranch(run.runBranch, head);
  engine.setCurrentCheckpoint(run.id, head);

  // Script in execution order like the positive test
  provider.script("sup", [
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "intake-planner", concerns: [], proposal: { goals: ["fix"], requirements: [{ ref: "R1", statement: "Fix it", acceptance: ["pass"] }], constraints: [], nonGoals: [], definitionOfSuccess: ["pass"], ambiguities: [] } }) },
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "intake-scope", concerns: [], proposal: {} }) },
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "intake-judge", concerns: [], proposal: {} }) },
  ]);
  // Probes
  provider.script("wkr", [
    { kind: "reply", content: "", toolCalls: [{ id: "pwkr", name: "probe_ping", arguments: "{}" }] },
    { kind: "reply", content: '{"probe":"ok"}' },
  ]);
  provider.script("sup", [
    { kind: "reply", content: "", toolCalls: [{ id: "psup", name: "probe_ping", arguments: "{}" }] },
    { kind: "reply", content: '{"probe":"ok"}' },
  ]);
  // Decompose
  provider.script("sup", [
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "decompose-planner", concerns: [], proposal: [{ title: "Fix", description: "WHAT: fix", kind: "bugfix", requirementRef: "R1", acceptance: ["pass"], complexity: "trivial", dependsOn: [] }] }) },
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "decompose-scope", concerns: [], proposal: { dropRefs: [] } }) },
    { kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "decompose-judge", concerns: [], proposal: { restoreRefs: [] } }) },
  ]);

  for (let i = 0; i < 15; i++) {
    const r = store.repos.runs.get(run.id)!;
    const supCalls = provider.calls.filter(c => c.model.model === "sup").length;
    const wkrCalls = provider.calls.filter(c => c.model.model === "wkr").length;
    console.log(`Tick ${i}: phase=${r.phase}, sup=${supCalls}, wkr=${wkrCalls}`);
    if (["DONE","NEEDS_HUMAN","FAILED"].includes(r.phase)) break;
    try {
      await engine.tickRun(run.id);
    } catch (e) {
      console.log(`Error at tick ${i}: ${(e as Error).message}`);
      console.log("sup purposes:", provider.calls.filter(c => c.model.model === "sup").map(c => `${c.metadata.purpose}[${provider.calls.indexOf(c)+1}]`));
      break;
    }
  }

  const finalR = store.repos.runs.get(run.id)!;
  console.log(`Final: phase=${finalR.phase}, sup_calls=${provider.calls.filter(c => c.model.model === "sup").length}`);
  console.log("Fallback calls:", callLog);
  console.log("Sup call purposes:", provider.calls.filter(c => c.model.model === "sup").map(c => c.metadata.purpose));

  store.close();
  rmSync(dir, { recursive: true, force: true });
  expect(true).toBe(true);
});
