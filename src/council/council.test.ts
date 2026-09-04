import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import { defaultConfig } from "../domain/config.js";
import { createInvestigationTask } from "../domain/task.js";
import { createMission, missionHash } from "../domain/mission.js";
import type { Finding } from "../domain/finding.js";
import { findingFingerprint } from "../domain/finding.js";
import type { ProjectProfile } from "../project/profile.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { buildPathologySample, detectStyleOnlyGrowth } from "../convergence/pathology/index.js";
import { aggregateCouncilDecision } from "./judge.js";
import { SupervisorCouncil } from "./council.js";
import type { RoleOpinion } from "./types.js";

describe("aggregateCouncilDecision", () => {
  it("lets judge approve break planner/scope_guardian revise disagreements", () => {
    const opinions: RoleOpinion[] = [
      { role: "planner", decision: "approve", rationale: "ok", concerns: [] },
      { role: "scope_guardian", decision: "revise", rationale: "wide", concerns: ["too broad"] },
      { role: "judge", decision: "approve", rationale: "bounded", concerns: [] },
    ];
    expect(aggregateCouncilDecision(opinions)).toBe("APPROVED");
  });

  it("returns NEEDS_HUMAN when any role requests human input", () => {
    const opinions: RoleOpinion[] = [
      { role: "planner", decision: "approve", rationale: "ok", concerns: [] },
      { role: "scope_guardian", decision: "needs_human", rationale: "blocked", concerns: ["unclear"] },
      { role: "judge", decision: "approve", rationale: "ok", concerns: [] },
    ];
    expect(aggregateCouncilDecision(opinions)).toBe("NEEDS_HUMAN");
  });
});

describe("SupervisorCouncil", () => {
  it("uses three independent calls for intake and builds a requirement-origin task DAG for a bugfix mission", async () => {
    const provider = scriptedCouncil(false);
    const council = new SupervisorCouncil({
      roles: councilRoles(provider),
      now: () => 10,
    });

    const intake = await council.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(intake.status).toBe("READY");
    if (intake.status !== "READY") return;
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls.map((call) => call.metadata.purpose)).toEqual([
      "council_intake_planner",
      "council_intake_scope",
      "council_intake_judge",
    ]);
    expect(new Set(provider.calls.map((call) => call.model.model))).toEqual(new Set(["planner", "scope", "judge"]));
    expect(intake.interpretation.requirements.length).toBeGreaterThanOrEqual(1);
    expect(intake.decision.opinions).toHaveLength(3);
    expect(intake.decision.events[0]?.payload["rationale"]).toContain("planner");

    const dag = await council.decompose(intake.interpretation);
    expect(provider.calls).toHaveLength(6);
    expect(dag.tasks.length).toBeGreaterThanOrEqual(1);
    expect(dag.tasks.every((task) => task.origin.kind === "mission_requirement")).toBe(true);
    expect(dag.tasks.some((task) => task.kind === "bugfix")).toBe(true);
    expect(dag.tasks.every((task) => task.acceptance.length > 0)).toBe(true);
    expect(dag.tasks.every((task) => task.baseCheckpointHash === BASELINE.commitHash)).toBe(true);
    expect(dag.decision.rationale).toContain("scope_guardian");
  });

  it("escalates blocking ambiguity instead of allowing decomposition", async () => {
    const provider = scriptedCouncil(true);
    const council = new SupervisorCouncil({ roles: councilRoles(provider) });
    const result = await council.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(result.status).toBe("NEEDS_HUMAN");
    if (result.status === "NEEDS_HUMAN") {
      expect(result.question).toBe("Which API should remain compatible?");
      expect(result.options).toEqual(["Public API", "Internal API"]);
      expect(result.interpretation).not.toBeNull();
      if (result.interpretation !== null) {
        await expect(council.decompose(result.interpretation)).rejects.toThrow("blocking ambiguity");
      }
    }
  });

  it("drops tasks the scope guardian marks out of scope", async () => {
    const provider = scriptedCouncil(false, { dropRefs: ["R2"] });
    const council = new SupervisorCouncil({ roles: councilRoles(provider), now: () => 10 });
    const intake = await council.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(intake.status).toBe("READY");
    if (intake.status !== "READY") return;
    const dag = await council.decompose(intake.interpretation);
    expect(dag.tasks).toHaveLength(1);
    expect(dag.tasks[0]?.origin).toMatchObject({ kind: "mission_requirement", requirementRef: "R1" });
    expect(dag.droppedRequirementRefs).toEqual(["R2"]);
  });

  it("does not invent a requirement when the planner returns none", async () => {
    const provider = scriptedCouncil(false, { emptyRequirements: true });
    const council = new SupervisorCouncil({ roles: councilRoles(provider), now: () => 10 });
    await expect(council.intake(BUGFIX_MISSION, PROFILE, BASELINE)).rejects.toMatchObject({ code: "OUTPUT_CONTRACT" });
  });

  it("returns NEEDS_HUMAN when every coding task is dropped", async () => {
    const provider = scriptedCouncil(false, { dropRefs: ["R1", "R2"] });
    const council = new SupervisorCouncil({ roles: councilRoles(provider), now: () => 10 });
    const intake = await council.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(intake.status).toBe("READY");
    if (intake.status !== "READY") return;
    const dag = await council.decompose(intake.interpretation);
    expect(dag.tasks).toHaveLength(0);
    expect(dag.decision.decision).toBe("NEEDS_HUMAN");
    expect(dag.droppedRequirementRefs).toEqual(["R1", "R2"]);
  });

  it("returns NEEDS_HUMAN when decomposition votes request a human", async () => {
    const provider = scriptedCouncil(false, { decomposeNeedsHuman: true });
    const council = new SupervisorCouncil({ roles: councilRoles(provider), now: () => 10 });
    const intake = await council.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(intake.status).toBe("READY");
    if (intake.status !== "READY") return;
    const dag = await council.decompose(intake.interpretation);
    expect(dag.tasks).toHaveLength(0);
    expect(dag.decision.decision).toBe("NEEDS_HUMAN");
  });

  it("persists structured style_only provenance on legal simplify tasks and fails safe otherwise", async () => {
    const styleProvider = scriptedCouncil(false, {
      decomposeTasks: [
        {
          title: "style_only simplify formatting",
          description: "style_only refactor of comments",
          requirementRef: "R1",
          acceptance: ["Formatting only"],
          kind: "simplify",
          workClass: "style_only",
          classifiedBy: "planner",
          sourceRef: "R1",
          dependsOn: [],
        },
      ],
      dropRefs: ["R2"],
    });
    const styleCouncil = new SupervisorCouncil({ roles: councilRoles(styleProvider), now: () => 10 });
    const styleIntake = await styleCouncil.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(styleIntake.status).toBe("READY");
    if (styleIntake.status !== "READY") return;
    const styleDag = await styleCouncil.decompose(styleIntake.interpretation);
    expect(styleDag.tasks).toHaveLength(1);
    expect(styleDag.tasks[0]).toMatchObject({
      kind: "simplify",
      workClass: "style_only",
      classifiedBy: "planner",
      sourceRef: "R1",
    });
    expect(styleDag.tasks[0]?.classificationEventId).toEqual(styleDag.decision.events[0]?.id);
    const plannerPrompt = styleProvider.calls.find((call) => call.metadata.purpose === "council_decompose_planner")?.messages[0]?.content;
    const scopePrompt = styleProvider.calls.find((call) => call.metadata.purpose === "council_decompose_scope")?.messages[0]?.content;
    expect(plannerPrompt).toMatch(/workClass/);
    expect(plannerPrompt).toMatch(/classifiedBy/);
    expect(plannerPrompt).toMatch(/sourceRef/);
    expect(scopePrompt).toMatch(/classifications|workClasses/);
    expect(scopePrompt).toMatch(/workClass/);

    const keywordProvider = scriptedCouncil(false, {
      decomposeTasks: [
        {
          title: "style_only simplify formatting",
          description: "style_only refactor of comments",
          requirementRef: "R1",
          acceptance: ["Formatting only"],
          kind: "simplify",
          dependsOn: [],
        },
      ],
      dropRefs: ["R2"],
    });
    const keywordCouncil = new SupervisorCouncil({ roles: councilRoles(keywordProvider), now: () => 10 });
    const keywordIntake = await keywordCouncil.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(keywordIntake.status).toBe("READY");
    if (keywordIntake.status !== "READY") return;
    const keywordDag = await keywordCouncil.decompose(keywordIntake.interpretation);
    expect(keywordDag.tasks[0]?.workClass).toBe("functional");
    expect(keywordDag.tasks[0]?.classifiedBy).toBeUndefined();
  });

  it("structured style_only simplify tasks can fire the growth detector; keyword-only and investigation cannot", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const runId = BASELINE.runId;
    const priorTask = {
      id: id("task", clock.now()),
      runId,
      title: "existing work",
      description: "WHAT: prior",
      kind: "feature" as const,
      origin: { kind: "mission_requirement" as const, interpretationId: id("mint", clock.now()), requirementRef: "R1" },
      acceptance: ["done"],
      complexity: "normal" as const,
      baseCheckpointHash: BASELINE.commitHash,
      dependsOn: [] as string[],
      state: "INTEGRATED" as const,
      attempts: 0,
      touchesProductCode: true,
      selectedCandidateId: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      workClass: "functional" as const,
    };
    const styleProvider = scriptedCouncil(false, {
      decomposeTasks: [
        {
          title: "style_only simplify formatting",
          requirementRef: "R1",
          acceptance: ["Formatting only"],
          kind: "simplify",
          workClass: "style_only",
          classifiedBy: "planner",
          sourceRef: "R1",
          dependsOn: [],
        },
      ],
      dropRefs: ["R2"],
    });
    const council = new SupervisorCouncil({ roles: councilRoles(styleProvider), now: () => clock.now() });
    const intake = await council.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(intake.status).toBe("READY");
    if (intake.status !== "READY") return;
    const styleTask = (await council.decompose(intake.interpretation)).tasks[0]!;
    expect(styleTask.workClass).toBe("style_only");

    const keywordProvider = scriptedCouncil(false, {
      decomposeTasks: [
        {
          title: "style_only simplify formatting",
          description: "style_only refactor",
          requirementRef: "R1",
          acceptance: ["Formatting only"],
          kind: "simplify",
          dependsOn: [],
        },
      ],
      dropRefs: ["R2"],
    });
    const keywordCouncil = new SupervisorCouncil({ roles: councilRoles(keywordProvider), now: () => clock.now() });
    const keywordIntake = await keywordCouncil.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(keywordIntake.status).toBe("READY");
    if (keywordIntake.status !== "READY") return;
    const keywordTask = (await keywordCouncil.decompose(keywordIntake.interpretation)).tasks[0]!;
    expect(keywordTask.workClass).toBe("functional");

    const uncertain: Finding = {
      id: id("find", clock.now()),
      runId,
      checkpointHash: "a".repeat(40),
      axis: "correctness",
      reportedBy: { kind: "reviewer", model: { provider: "p", model: "m" } },
      status: "UNCERTAIN",
      duplicateOf: null,
      fingerprint: findingFingerprint({ criterion: "x", claim: "unclear", evidence: [] }),
      investigationRounds: 0,
      criterion: "x",
      severity: "high",
      blocking: true,
      claim: "unclear",
      evidence: [],
      reproduction: ["x"],
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };
    const investigation = createInvestigationTask(uncertain, 3, {
      id: id("task", clock.now() + 1),
      runId,
      title: "style_only investigate",
      description: "style_only investigation",
      acceptance: ["clarify"],
      complexity: "normal",
      baseCheckpointHash: BASELINE.commitHash,
      now: clock.now(),
      workClass: "style_only",
      classifiedBy: "planner",
      sourceRef: uncertain.id,
      classificationEventId: id("evt", clock.now()),
    });
    expect(investigation.workClass).toBe("functional");

    const detectAdded = (added: typeof styleTask) => {
      const evidence = {
        gates: { test: "pass" as const },
        testsPassed: 1,
        testsFailed: 0,
        testsTotal: 1,
        openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        diffLinesFromBaseline: 1,
      };
      const checkpoint = (seq: number, hash: string) => ({
        id: id("cp", clock.now() + seq),
        runId,
        seq,
        commitHash: hash,
        parentId: null,
        source: "integration" as const,
        taskId: priorTask.id,
        evidence,
        createdAt: clock.now() + seq,
      });
      const events = [
        {
          id: id("evt", clock.now()),
          runId,
          ts: clock.now(),
          schemaVersion: 1 as const,
          seq: 1,
          type: "task.created",
          payload: { task: priorTask },
          causedBy: [],
          actor: { kind: "system" as const },
          artifacts: [],
        },
        {
          id: id("evt", clock.now() + 2),
          runId,
          ts: clock.now() + 2,
          schemaVersion: 1 as const,
          seq: 2,
          type: "checkpoint.created",
          payload: { checkpoint: checkpoint(1, "a".repeat(40)) },
          causedBy: [],
          actor: { kind: "system" as const },
          artifacts: [],
        },
        {
          id: id("evt", clock.now() + 3),
          runId,
          ts: clock.now() + 3,
          schemaVersion: 1 as const,
          seq: 3,
          type: "checkpoint.created",
          payload: { checkpoint: checkpoint(2, "b".repeat(40)) },
          causedBy: [],
          actor: { kind: "system" as const },
          artifacts: [],
        },
        {
          id: id("evt", clock.now() + 4),
          runId,
          ts: clock.now() + 4,
          schemaVersion: 1 as const,
          seq: 4,
          type: "task.created",
          payload: { task: added },
          causedBy: [],
          actor: { kind: "system" as const },
          artifacts: [],
        },
        {
          id: id("evt", clock.now() + 5),
          runId,
          ts: clock.now() + 5,
          schemaVersion: 1 as const,
          seq: 5,
          type: "checkpoint.created",
          payload: { checkpoint: checkpoint(3, "c".repeat(40)) },
          causedBy: [],
          actor: { kind: "system" as const },
          artifacts: [],
        },
      ];
      const samples = events
        .filter((event) => event.type === "checkpoint.created")
        .map((boundary) => buildPathologySample({ events, boundary, config: defaultConfig() }));
      return detectStyleOnlyGrowth(samples, 3);
    };

    expect(detectAdded(styleTask)).not.toBeNull();
    expect(detectAdded(keywordTask)).toBeNull();
    expect(detectAdded(investigation)).toBeNull();
  });

  it("does not mutate the raw mission hash during interpretation", async () => {
    const provider = scriptedCouncil(false);
    const council = new SupervisorCouncil({ roles: councilRoles(provider), now: () => 10 });
    const before = missionHash(BUGFIX_MISSION);
    await council.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(missionHash(BUGFIX_MISSION)).toBe(before);
    expect(BUGFIX_MISSION.hash).toBe(before);
  });

  it("intake payload includes bounded resume-dup-fetch baseline evidence, not a sha256-only snapshot", async () => {
    const stdout = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/resume-dup-fetch/baseline-test.stdout.txt"),
      "utf8",
    );
    const forensic = JSON.stringify({
      command: ["npm", "run", "test"],
      status: "fail",
      exitCode: 1,
      stdout,
      stderr: "",
      diagnostics: [
        "    not ok 2 - retries after transient failure and succeeds",
        "      error: 'duplicate in-flight request detected'",
        "# tests 3",
        "# pass 2",
        "# fail 1",
      ],
    });
    const provider = scriptedCouncil(false);
    const council = new SupervisorCouncil({ roles: councilRoles(provider), now: () => 10 });
    const result = await council.intake(SMOKE_MISSION, SMOKE_PROFILE, SMOKE_BASELINE, {
      readCheckOutput: (sha) => (sha === SMOKE_OUTPUT_SHA ? forensic : null),
    });
    expect(result.status).toBe("READY");
    const user = provider.calls[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user).toContain("informational");
    expect(user).toContain("authoritative");
    expect(user).toContain("baselineEvidence");
    expect(user).toContain("duplicate in-flight request detected");
    expect(user).toContain("retries after transient failure and succeeds");
    expect(user).toContain("npm");
    expect(user).not.toContain("TAP version 13");
    expect(user).not.toContain("node:internal/test_runner");
    expect(user).not.toMatch(/"summary":null/);
    expect(provider.calls[0]?.messages[0]?.content).toContain("baselineEvidence");
    expect(provider.calls[2]?.messages[0]?.content).toContain("no code proposal");
  });

  it("keeps genuine product ambiguity as NEEDS_HUMAN even when baseline evidence is present", async () => {
    const stdout = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/resume-dup-fetch/baseline-test.stdout.txt"),
      "utf8",
    );
    const forensic = JSON.stringify({
      command: ["npm", "run", "test"],
      stdout,
      stderr: "",
      diagnostics: ["error: 'duplicate in-flight request detected'"],
    });
    const provider = scriptedCouncil(true);
    const council = new SupervisorCouncil({ roles: councilRoles(provider) });
    const result = await council.intake(SMOKE_MISSION, SMOKE_PROFILE, SMOKE_BASELINE, {
      readCheckOutput: (sha) => (sha === SMOKE_OUTPUT_SHA ? forensic : null),
    });
    expect(result.status).toBe("NEEDS_HUMAN");
    if (result.status === "NEEDS_HUMAN") {
      expect(result.question).toBe("Which API should remain compatible?");
    }
  });

  it("invalid sibling JSON is OUTPUT_CONTRACT and does not start another intake trio", async () => {
    const provider = new ScriptedProvider("council", [
      { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
      { name: "scope", capabilities: FAKE_CAPABILITIES.strong },
      { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
    ]);
    provider.script("planner", [
      {
        kind: "reply",
        content: JSON.stringify({
          decision: "approve",
          rationale: "ok",
          concerns: [],
          proposal: {
            goals: ["Fix login"],
            requirements: [{ ref: "R1", statement: "Fix login timeout", acceptance: ["Login works"] }],
            constraints: [],
            nonGoals: [],
            definitionOfSuccess: ["Checks pass"],
            ambiguities: [],
          },
        }),
      },
    ]);
    provider.script("scope", [opinion("approve", "Scope is bounded.", [])]);
    provider.script("judge", [{ kind: "reply", content: "definitely not json" }]);
    const council = new SupervisorCouncil({ roles: councilRoles(provider), now: () => 10 });
    await expect(council.intake(BUGFIX_MISSION, PROFILE, BASELINE)).rejects.toMatchObject({ code: "OUTPUT_CONTRACT" });
    expect(provider.calls).toHaveLength(3);
  });
});

function councilRoles(provider: ScriptedProvider) {
  return {
    planner: { client: provider, model: { provider: "council", model: "planner" } },
    scope_guardian: { client: provider, model: { provider: "council", model: "scope" } },
    judge: { client: provider, model: { provider: "council", model: "judge" } },
  };
}

function scriptedCouncil(
  blocking: boolean,
  opts: {
    dropRefs?: string[];
    emptyRequirements?: boolean;
    decomposeNeedsHuman?: boolean;
    decomposeTasks?: Record<string, unknown>[];
  } = {},
): ScriptedProvider {
  const provider = new ScriptedProvider("council", [
    { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
    { name: "scope", capabilities: FAKE_CAPABILITIES.strong },
    { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
  ]);
  provider.script("planner", [
    {
      kind: "reply",
      content: JSON.stringify({
        decision: "approve",
        rationale: "Requirements are concrete.",
        concerns: [],
        proposal: {
          goals: ["Fix the login bug"],
          requirements: opts.emptyRequirements
            ? []
            : [
            { ref: "R1", statement: "Fix login timeout", acceptance: ["Login succeeds within 2s"] },
            { ref: "R2", statement: "Add social login", acceptance: ["OAuth works"] },
          ],
          constraints: ["Do not edit the plan"],
          nonGoals: ["No new features beyond the bugfix"],
          definitionOfSuccess: ["Checks pass"],
          ambiguities: blocking
            ? [{ question: "Which API should remain compatible?", options: ["Public API", "Internal API"], blocking: true }]
            : [],
        },
      }),
    },
    {
      kind: "reply",
      content: JSON.stringify({
        decision: "approve",
        rationale: "The DAG covers every requirement.",
        concerns: [],
        proposal: {
          tasks: opts.decomposeTasks ?? [
            { title: "Fix login", requirementRef: "R1", acceptance: ["Login works"], kind: "bugfix", dependsOn: [] },
            { title: "Social login", requirementRef: "R2", acceptance: ["OAuth"], kind: "feature", dependsOn: [] },
          ],
        },
      }),
    },
  ]);
  provider.script("scope", [
    opinion(blocking ? "needs_human" : "approve", "Scope is bounded.", blocking ? ["Compatibility is unclear."] : []),
    {
      kind: "reply",
      content: JSON.stringify({
        decision: "approve",
        rationale: "Out-of-scope work removed.",
        concerns: [],
        proposal: {
          dropRefs: opts.dropRefs ?? [],
        },
      }),
    },
  ]);
  provider.script("judge", [
    opinion("approve", "Acceptance is testable.", []),
    opinion(opts.decomposeNeedsHuman === true ? "needs_human" : "approve", "The plan is executable.", opts.decomposeNeedsHuman === true ? ["Need a product decision."] : []),
  ]);
  return provider;
}

function opinion(decision: "approve" | "needs_human" | "revise", rationale: string, concerns: string[]): {
  kind: "reply";
  content: string;
} {
  return { kind: "reply", content: JSON.stringify({ decision, rationale, concerns }) };
}

const BUGFIX_MISSION = createMission({
  id: "msn_0000000000000000000000",
  projectPath: "/repo",
  text: "Fix the login timeout bug",
  userConstraints: ["Do not edit the plan"],
  createdAt: 1,
});

const PROFILE: ProjectProfile = {
  projectPath: "/repo",
  alias: null,
  packageManager: "pnpm",
  framework: "vitest",
  checks: [{ name: "test", kind: "test", command: ["pnpm", "test"], mandatory: true }],
  manifestHashes: {},
  scriptsHash: "a".repeat(64),
  discoveredAt: 1,
};

const BASELINE: BaselineSnapshot = {
  id: "base_0000000000000000000000",
  runId: "run_0000000000000000000000",
  commitHash: "abcdef1",
  checks: [],
  configHashes: {},
  scriptsHash: "a".repeat(64),
  toolchain: {},
  createdAt: 1,
};

const SMOKE_OUTPUT_SHA = "2f978b24b034778d852a6cef080ff689153b8e2318635bab6e44b48eec228b62";

const SMOKE_MISSION = createMission({
  id: "msn_0000000000000000000001",
  projectPath: "/tmp/polish-smoke",
  text: "Fix the RetryFetcher retry bug. A transient failure must retry and succeed without triggering duplicate in-flight detection. Preserve the existing public API and maxRetries semantics. Do not add dependencies or refactor unrelated code. This is one bounded coding task.",
  createdAt: 1,
});

const SMOKE_PROFILE: ProjectProfile = {
  projectPath: "/tmp/polish-smoke",
  alias: null,
  packageManager: null,
  framework: "node-test",
  checks: [{ name: "test", kind: "test", command: ["npm", "run", "test"], mandatory: true, timeoutMs: 600_000 }],
  manifestHashes: {},
  scriptsHash: "a".repeat(64),
  discoveredAt: 1,
};

const SMOKE_BASELINE: BaselineSnapshot = {
  ...BASELINE,
  checks: [
    {
      name: "test",
      kind: "test",
      status: "fail",
      exitCode: 1,
      durationMs: 174,
      summary: null,
      outputRef: {
        sha256: SMOKE_OUTPUT_SHA,
        kind: "check_output",
        bytes: 2437,
        label: "ed6b93c3c42143721193b026ba0f7ef709929fd0:test",
      },
    },
  ],
};
