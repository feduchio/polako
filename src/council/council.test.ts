import { describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import { createMission, missionHash } from "../domain/mission.js";
import type { ProjectProfile } from "../project/profile.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
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

  it("does not mutate the raw mission hash during interpretation", async () => {
    const provider = scriptedCouncil(false);
    const council = new SupervisorCouncil({ roles: councilRoles(provider), now: () => 10 });
    const before = missionHash(BUGFIX_MISSION);
    await council.intake(BUGFIX_MISSION, PROFILE, BASELINE);
    expect(missionHash(BUGFIX_MISSION)).toBe(before);
    expect(BUGFIX_MISSION.hash).toBe(before);
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
  opts: { dropRefs?: string[]; emptyRequirements?: boolean; decomposeNeedsHuman?: boolean } = {},
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
          tasks: [
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

function opinion(decision: "approve" | "needs_human", rationale: string, concerns: string[]): {
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
