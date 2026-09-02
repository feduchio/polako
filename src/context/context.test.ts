import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyFindingCounts } from "../domain/checkpoint.js";
import { createMission } from "../domain/mission.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { PolishError } from "../shared/errors.js";
import {
  buildMissionContext,
  buildSupervisorView,
  buildWorkerContextPack,
  discloseFailedAttempts,
  FactsService,
  formatFactForPrompt,
} from "./index.js";
import type { Task } from "../domain/task.js";
import type { Finding } from "../domain/finding.js";
import type { Fact } from "../domain/fact.js";
import type { Checkpoint } from "../domain/checkpoint.js";

const NOW = 1_700_000_000_000;
const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function sampleTask(runId: string): Task {
  return {
    id: id("task", NOW),
    runId,
    title: "Fix add",
    description: "Fix add in src/math.ts",
    kind: "bugfix",
    origin: { kind: "mission_requirement", interpretationId: id("mint", NOW), requirementRef: "R1" },
    acceptance: ["add(1,1)===2"],
    complexity: "trivial",
    baseCheckpointHash: HASH,
    dependsOn: [],
    state: "READY",
    attempts: 0,
    touchesProductCode: true,
    selectedCandidateId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("context builders + FactsService", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let facts: FactsService;
  const runId = id("run", NOW);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-ctx-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    facts = new FactsService(store, clock);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildMissionContext is a full immutable snapshot", () => {
    const mission = createMission({
      id: id("msn", NOW),
      projectPath: "/tmp/p",
      text: "fix the bug",
      userConstraints: ["no scope creep"],
      userDecisions: ["use vitest"],
      createdAt: NOW,
    });
    const ctx = buildMissionContext(mission);
    expect(ctx.text).toBe("fix the bug");
    expect(ctx.hash).toBe(mission.hash);
    expect(ctx.userConstraints).toEqual(["no scope creep"]);
    ctx.userConstraints.push("mut");
    expect(mission.userConstraints).toEqual(["no scope creep"]);
  });

  it("formatFactForPrompt labels hypotheses", () => {
    const inferred: Fact = {
      id: id("fact", NOW),
      runId,
      kind: "behavior",
      statement: "maybe flaky",
      provenanceKind: "llm_inferred",
      provenanceRefs: [id("evt", NOW)],
      evidenceRefs: [],
      confidence: 0.4,
      tags: ["test"],
      files: ["a.ts"],
      supersededBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(formatFactForPrompt(inferred)).toContain("hypothesis");
    const det = { ...inferred, provenanceKind: "deterministic" as const, confidence: null };
    expect(formatFactForPrompt(det)).toContain("[deterministic]");
    expect(formatFactForPrompt(det)).not.toContain("hypothesis");
  });

  it("FactsService promote only from llm_inferred via evidence event", () => {
    const f = facts.record({
      runId,
      kind: "behavior",
      statement: "add is broken",
      provenanceKind: "llm_inferred",
      provenanceRefs: [id("evt", NOW)],
      evidenceRefs: [],
      confidence: 0.7,
      tags: [],
      files: ["src/math.ts"],
    });
    expect(() => facts.promote(f.id, id("evt", NOW + 1))).not.toThrow();
    expect(store.repos.facts.get(f.id)?.provenanceKind).toBe("verified");

    const det = facts.record({
      runId,
      kind: "project_check",
      statement: "vitest present",
      provenanceKind: "deterministic",
      provenanceRefs: [id("evt", NOW + 2)],
      evidenceRefs: [],
      confidence: null,
      tags: [],
      files: [],
    });
    expect(() => facts.promote(det.id, id("evt", NOW + 3))).toThrow(PolishError);
  });

  it("consolidate supersedes duplicate statements", async () => {
    facts.record({
      runId,
      kind: "convention",
      statement: "Use ESM",
      provenanceKind: "user_stated",
      provenanceRefs: [id("evt", NOW)],
      evidenceRefs: [],
      confidence: null,
      tags: [],
      files: [],
    });
    await clock.advance(1);
    facts.record({
      runId,
      kind: "convention",
      statement: "use  esm",
      provenanceKind: "user_stated",
      provenanceRefs: [id("evt", NOW + 1)],
      evidenceRefs: [],
      confidence: null,
      tags: [],
      files: [],
    });
    const r = facts.consolidate(runId);
    expect(r.kept).toBe(1);
    expect(r.superseded).toBe(1);
    expect(facts.listCurrent(runId)).toHaveLength(1);
  });

  it("supervisor view ranks facts and lists unresolved findings", () => {
    const task = sampleTask(runId);
    const factA = facts.record({
      runId,
      kind: "decision",
      statement: "ship fix",
      provenanceKind: "user_stated",
      provenanceRefs: [id("evt", NOW)],
      evidenceRefs: [],
      confidence: null,
      tags: ["mission"],
      files: ["src/math.ts"],
    });
    const finding: Finding = {
      id: id("find", NOW),
      runId,
      checkpointHash: HASH,
      axis: "correctness",
      criterion: "spec",
      severity: "high",
      blocking: true,
      claim: "add wrong",
      evidence: [{ path: "src/math.ts", line: 1, endLine: 2 }],
      reproduction: ["pnpm test"],
      reportedBy: { kind: "system" },
      status: "VALID",
      duplicateOf: null,
      fingerprint: "abc",
      investigationRounds: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const cp: Checkpoint = {
      id: id("cp", NOW),
      runId,
      seq: 1,
      commitHash: HASH,
      parentId: null,
      source: "baseline",
      taskId: null,
      evidence: {
        gates: { test: "pass" },
        testsPassed: 1,
        testsFailed: 0,
        testsTotal: 1,
        openValidatedFindings: emptyFindingCounts(),
        diffLinesFromBaseline: 0,
      },
      createdAt: NOW,
    };
    const view = buildSupervisorView({
      runId,
      tasks: [task],
      facts: [factA],
      findings: [finding],
      checkpoints: [cp],
      focusFiles: ["src/math.ts"],
    });
    expect(view.tasks[0]?.blockedBy).toEqual([]);
    expect(view.facts.some((s) => s.includes("ship fix"))).toBe(true);
    expect(view.decisions.length).toBe(1);
    expect(view.unresolvedFindings).toHaveLength(1);
    expect(view.checkpoints[0]?.evidenceDigest).toContain("tests=1/1");
  });

  it("worker pack progressive disclosure and budget drop protocol last among optionals", () => {
    const task = sampleTask(runId);
    const attempts = [
      { attempt: 1, summary: "failed once", errorExcerpt: "TypeError", detail: "full stack" },
    ];
    expect(discloseFailedAttempts(attempts, 1)[0]?.errorExcerpt).toBeUndefined();
    expect(discloseFailedAttempts(attempts, 2)[0]?.errorExcerpt).toBe("TypeError");
    expect(discloseFailedAttempts(attempts, 3)[0]?.detail).toBe("full stack");

    const hugeProtocol = { promptText: "P".repeat(4000), hash: "h1", members: [], totalBudgetTokens: 1000 };
    const pack = buildWorkerContextPack({
      task,
      protocol: hugeProtocol,
      facts: [],
      findings: [],
      fileFragments: [{ path: "src/math.ts", startLine: 1, endLine: 2, text: "export function add(){}" }],
      failedAttempts: attempts,
      attemptNumber: 1,
      tools: ["read", "write"],
      maxPackTokens: 200,
    });
    expect(pack.included).toContain("task");
    expect(pack.estimatedTokens).toBeLessThanOrEqual(200);
    // failedAttempts dropped or protocol trimmed via DROP_ORDER
    expect(!pack.sections["failedAttempts"]?.includes("TypeError")).toBe(true);
  });
});
