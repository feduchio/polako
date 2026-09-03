import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { Git } from "../sandbox/git.js";
import { DaemonService } from "./service.js";

function plannerIntake(): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "Concrete bugfix mission.",
    concerns: [],
    proposal: {
      goals: ["Improve reliability"],
      requirements: [
        {
          ref: "R1",
          statement: "Ensure noop mission can be planned",
          acceptance: ["tests pass"],
          blocking: false,
        },
      ],
      constraints: [],
      nonGoals: [],
      definitionOfSuccess: ["tests pass"],
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
    rationale: "Plan is testable.",
    concerns: [],
    proposal: extra,
  });
}

function plannerDecompose(): string {
  return JSON.stringify({
    decision: "approve",
    rationale: "One coding task.",
    concerns: [],
    proposal: [
      {
        title: "Implement requirement R1",
        description: "WHAT: noop planning path\nWHY: bootstrap test\nCONSTRAINTS: none\nEVIDENCE: mission",
        kind: "feature",
        requirementRef: "R1",
        acceptance: ["tests pass"],
        complexity: "trivial",
        dependsOn: [],
      },
    ],
  });
}

function opinion(content: string) {
  return { kind: "reply" as const, content };
}

describe("daemon bootstrap – pinned council without pre-discover", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("runs INTERPRETING_MISSION and PLANNING via config-loaded scripted council", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-bootstrap-daemon-"));
    dirs.push(dir);
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir);
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }),
    );
    const git = await Git.init(repoDir);
    await git.commitAll("init");

    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "secrets.env"), "FAKE_OPENROUTER_KEY=sk-fake-not-real\n", { mode: 0o600 });
    writeFileSync(
      join(home, "polish.toml"),
      `
[[providers]]
id = "scripted"
kind = "scripted"
enabled = true
models = ["planner", "scope", "judge", "wkr"]

[[providers]]
id = "openrouter"
kind = "openrouter"
enabled = true
apiKeyEnv = "OPENROUTER_API_KEY"

[[supervisors]]
role = "planner"
model = "scripted:planner"

[[supervisors]]
role = "scope_guardian"
model = "scripted:scope"

[[supervisors]]
role = "judge"
model = "scripted:judge"

[runtimeValidation]
mode = "off"
`,
    );

    const clock = new FakeClock(1_700_000_000_000);
    const service = new DaemonService({ home, clock, tickMs: 1 });
    const config = service.getConfig();
    expect(config.supervisors).toHaveLength(3);
    expect(service.productionComposition().providers.map((p) => p.id)).toEqual(["scripted"]);

    const provider = service.productionComposition().providers[0] as ScriptedProvider;
    provider.script("planner", [opinion(plannerIntake())]);
    provider.script("scope", [opinion(supervisorApprove())]);
    provider.script("judge", [opinion(judgeApprove())]);
    for (const model of ["wkr", "planner", "scope", "judge"]) {
      provider.script(model, [
        {
          kind: "reply",
          content: "",
          toolCalls: [{ id: `p-${model}`, name: "probe_ping", arguments: "{}" }],
        },
        { kind: "reply", content: '{"probe":"ok"}' },
      ]);
    }
    provider.script("planner", [opinion(plannerDecompose())]);
    provider.script("scope", [opinion(supervisorApprove({ dropRefs: [] }))]);
    provider.script("judge", [opinion(judgeApprove({ restoreRefs: [] }))]);

    const created = await service.handle("run", {
      project: repoDir,
      mission: "bootstrap noop mission",
      runtime: "off",
    });
    const runId = (created as { id: string }).id;

    for (let i = 0; i < 80; i++) {
      const run = service.store.repos.runs.get(runId)!;
      if (run.phase === "EXECUTING" || run.phase === "REVIEWING") break;
      if (run.phase === "NEEDS_HUMAN" || run.phase === "FAILED" || run.phase === "DONE") break;
      await service.engine.tickRun(runId);
    }

    const run = service.store.repos.runs.get(runId)!;
    expect(run.interpretationId).not.toBeNull();
    expect(service.store.events.list(runId, { types: ["mission.interpreted"] })).toHaveLength(1);
    expect(service.store.events.list(runId, { types: ["council.role_resolved"] }).length).toBeGreaterThanOrEqual(3);
    expect(["EXECUTING", "REVIEWING"]).toContain(run.phase);
    expect(service.store.events.list(runId, { types: ["task.created"] }).length).toBeGreaterThanOrEqual(1);

    await service.close();
  });
});
