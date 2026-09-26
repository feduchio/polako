import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Event } from "../domain/event.js";
import { defaultConfig } from "../domain/config.js";
import type { TerminalReason } from "../domain/run.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import type { Run } from "../domain/run.js";
import {
  buildFinalReportInput,
  buildNeedsHumanReportInput,
  mentionedPhases,
} from "./build.js";
import { emitNeedsHumanReport, emitFinalReport } from "./emit.js";
import { renderFinalReport, renderNeedsHumanReport } from "./reports.js";
import { SemanticEventLog, renderSemanticLog } from "./semanticLog.js";

const NOW = 1_700_000_000_000;

describe("semantic event log", () => {
  it("renders a readable ordered timeline instead of raw event JSON", () => {
    const rendered = renderSemanticLog([...EVENTS].reverse());
    expect(rendered.split("\n")[0]).toContain("Mission recorded");
    expect(rendered).toContain("Finding validated");
    expect(rendered).toContain("Candidate checks completed");
    expect(rendered).not.toContain('"payload"');
  });

  it("builds a mission-to-verdict why-chain around a domain entity", () => {
    const chain = new SemanticEventLog(EVENTS).whyChain("task_0000000000000000000000");
    expect(chain.map((step) => step.stage)).toEqual([
      "mission",
      "finding",
      "validation",
      "task",
      "candidate",
      "diff",
      "checks",
      "verdict",
    ]);
    expect(chain.at(-1)?.causedBy).toEqual(["evt_0000000000000000000006"]);
  });

  it("follows causedBy links instead of timestamp-only concatenation", () => {
    const unrelated = event(99, "shell.command", { command: "pnpm test" }, []);
    const chain = new SemanticEventLog([...EVENTS, unrelated]).whyChain("task_0000000000000000000000");
    expect(chain.some((step) => step.summary.includes("pnpm test"))).toBe(false);
    expect(chain).toHaveLength(8);
  });
});

describe("reports", () => {
  it("puts the action first and presents no more than five numbered choices", () => {
    const report = renderNeedsHumanReport({
      question: "Choose the compatibility target.",
      context: "Both targets are plausible and change the implementation.",
      options: ["Keep public API", "Keep internal API", "Stop"],
      recommendation: "Keep public API",
    });
    expect(report.split("\n")[0]).toBe("ACTION REQUIRED: Choose the compatibility target.");
    expect(report).toContain("1. Keep public API");
    expect(report).toContain("3. Stop");
    expect(report.split("\n").at(-1)).toBe("Reply with a number.");
    const bounded = renderNeedsHumanReport({
      question: "Too many",
      options: ["1", "2", "3", "4", "5", "6"],
    });
    expect(bounded).toContain("5. 5");
    expect(bounded).not.toContain("6. 6");
  });

  it("marks successful final output DONE before details", () => {
    const report = renderFinalReport({
      summary: "Mission complete",
      changes: ["deduplicated resume fetch"],
      reasons: ["one resume must issue one request"],
      rejected: ["global debounce: changes unrelated request semantics"],
      checks: ["pnpm check passed"],
      findings: ["duplicate request reproduced"],
      validation: ["runtime evidence passed"],
      convergence: ["three clean rounds on checkpoint abc"],
      evidence: ["report artifact persisted"],
    });
    expect(report).toMatch(/^DONE: Mission complete/);
    for (const section of ["Changed:", "Why:", "Rejected:", "Verified:", "Findings:", "Validation:", "Convergence:", "Evidence:"]) {
      expect(report).toContain(section);
    }
  });

  it("includes candidate commits from fixture events and omits unmentioned phases", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-b8-report-"));
    const store = openStore({ artifactsDir: join(dir, "artifacts") });
    try {
      const clock = new FakeClock(NOW);
      const runId = id("run", clock.now());
      const commitHash = "c".repeat(40);
      const candidate = {
        id: "cand_0000000000000000000000",
        runId,
        taskId: "task_0000000000000000000000",
        attempt: 1,
        model: { provider: "p", model: "worker" },
        baseCheckpointHash: "a".repeat(40),
        branch: "cand/1",
        worktreePath: null,
        headCommit: commitHash,
        state: "PASSED_GATES" as const,
        gateReport: null,
        transcriptRef: null,
        diffRef: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };
      store.events.append([{
        id: id("evt", clock.now()),
        runId,
        ts: clock.now(),
        type: "candidate.created",
        payload: { candidate },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
      const run: Run = {
        id: runId,
        missionId: id("msn", clock.now()),
        projectPath: "/repo",
        runBranch: "run",
        phase: "CONVERGENCE_CHECK",
        control: "RUNNING",
        currentCheckpointHash: commitHash,
        baselineId: null,
        interpretationId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      };
      const report = renderFinalReport(buildFinalReportInput(reportCtx(run, store, clock)));
      expect(report).toContain(commitHash);
      expect(report.startsWith("DONE:")).toBe(true);

      // A failed run must not be reported as done, and must carry the actionable part.
      const failed: Run = {
        ...run,
        phase: "FAILED",
        terminalReason: {
          code: "environment_not_ready",
          summary: "gates not run: dependency install is disabled",
          question: "Make the install possible here, then start a new run.",
        },
      };
      const failedReport = renderFinalReport(buildFinalReportInput(reportCtx(failed, store, clock)));
      expect(failedReport.startsWith("FAILED:")).toBe(true);
      expect(failedReport).toContain("gates not run: dependency install is disabled");
      expect(failedReport).toContain("Make the install possible here");
      expect(failedReport).not.toContain("Mission complete");
      expect(mentionedPhases(EVENTS)).toEqual(["mission", "planning", "execution", "integration", "review"]);
      expect(mentionedPhases(EVENTS)).not.toContain("baseline");
      expect(mentionedPhases(EVENTS)).not.toContain("convergence");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NEEDS_HUMAN report contains the question from terminalReason", () => {
    const reason: TerminalReason = {
      code: "ambiguous_intent",
      summary: "Compatibility is unclear.",
      question: "Which API should remain compatible?",
      options: ["Public API", "Internal API"],
    };
    const report = renderNeedsHumanReport(buildNeedsHumanReportInput(reason));
    expect(report).toContain("Which API should remain compatible?");
    expect(report).toContain("1. Public API");
  });

  it("final report checkpoint hash matches run.currentCheckpointHash", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-b8-checkpoint-"));
    const store = openStore({ artifactsDir: join(dir, "artifacts") });
    try {
      const clock = new FakeClock(NOW);
      const checkpointHash = "f".repeat(40);
      const runId = id("run", clock.now());
      const run = {
        id: runId,
        missionId: id("msn", clock.now()),
        projectPath: "/repo",
        runBranch: "run",
        phase: "DONE" as const,
        control: "RUNNING" as const,
        currentCheckpointHash: checkpointHash,
        baselineId: null,
        interpretationId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      };
      const input = buildFinalReportInput({ run, store, clock, config: defaultConfig() });
      expect(input.summary).toContain(checkpointHash);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists well-formed mechanism manifest entries and skips malformed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-mechanisms-"));
    const store = openStore({ artifactsDir: join(dir, "artifacts") });
    try {
      const clock = new FakeClock(NOW);
      const runId = id("run", clock.now());
      store.events.append([{
        id: id("evt", clock.now()),
        runId,
        ts: clock.now(),
        type: "run.mechanisms",
        payload: {
          mechanisms: [
            null,
            "review_quorum",
            { name: 7, on: true },
            { name: "debate_diversity" },
            { name: "progress_tracker", on: false, reason: "insufficient_families: 1" },
            { name: "review_quorum", on: true },
          ],
        },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
      const run: Run = {
        id: runId,
        missionId: id("msn", clock.now()),
        projectPath: "/repo",
        runBranch: "run",
        phase: "DONE",
        control: "RUNNING",
        currentCheckpointHash: null,
        baselineId: null,
        interpretationId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      };
      const input = buildFinalReportInput(reportCtx(run, store, clock));
      expect((input.evidence ?? []).filter((line) => line.startsWith("Mechanism"))).toEqual([
        "Mechanism progress_tracker: off (insufficient_families: 1)",
        "Mechanism review_quorum: on",
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("production report emission", () => {
  it("emitFinalReport persists report.generated without mutating projections", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-b8-emit-"));
    const store = openStore({ artifactsDir: join(dir, "artifacts") });
    try {
      const clock = new FakeClock(NOW);
      const runId = id("run", clock.now());
      const checkpointHash = "d".repeat(40);
      const run = {
        id: runId,
        missionId: id("msn", clock.now()),
        projectPath: "/repo",
        runBranch: "run",
        phase: "CONVERGENCE_CHECK" as const,
        control: "RUNNING" as const,
        currentCheckpointHash: checkpointHash,
        baselineId: null,
        interpretationId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      };
      const ctx = { run, store, clock, config: defaultConfig() };
      const ref = emitFinalReport(ctx);
      const events = store.events.list(runId, { types: ["report.generated"] });
      expect(events).toHaveLength(1);
      expect(events[0]?.artifacts[0]?.sha256).toBe(ref.sha256);
      expect(store.artifacts.getText(ref.sha256)).toContain(checkpointHash);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emitNeedsHumanReport persists the terminal question", () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-b8-needs-human-"));
    const store = openStore({ artifactsDir: join(dir, "artifacts") });
    try {
      const clock = new FakeClock(NOW);
      const runId = id("run", clock.now());
      const run = {
        id: runId,
        missionId: id("msn", clock.now()),
        projectPath: "/repo",
        runBranch: "run",
        phase: "INTERPRETING_MISSION" as const,
        control: "RUNNING" as const,
        currentCheckpointHash: null,
        baselineId: null,
        interpretationId: null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      };
      emitNeedsHumanReport(reportCtx(run, store, clock), {
        code: "ambiguous_intent",
        summary: "Compatibility is unclear.",
        question: "Which API should remain compatible?",
        options: ["Public API", "Internal API"],
      });
      const body = store.artifacts.getText(store.events.list(runId, { types: ["report.generated"] })[0]!.artifacts[0]!.sha256);
      expect(body).toContain("Which API should remain compatible?");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function reportCtx(run: Run, store: Store, clock: FakeClock) {
  return { run, store, clock, config: defaultConfig() };
}

function event(seq: number, type: string, payload: Record<string, unknown>, causedBy: string[]): Event {
  return {
    schemaVersion: 1,
    id: `evt_000000000000000000000${seq}`,
    runId: "run_0000000000000000000000",
    seq,
    ts: seq,
    type,
    payload,
    causedBy,
    actor: { kind: "system" },
    artifacts: [],
  };
}

const EVENTS: Event[] = [
  event(0, "mission.recorded", { mission: { id: "msn_0000000000000000000000" } }, []),
  event(1, "finding.raised", { finding: { id: "find_0000000000000000000000" }, claim: "Missing guard" }, ["evt_0000000000000000000000"]),
  event(2, "finding.validated", { validationId: "fval_0000000000000000000000", verdict: "VALID" }, ["evt_0000000000000000000001"]),
  event(3, "task.created", { task: { id: "task_0000000000000000000000", title: "Add guard" } }, ["evt_0000000000000000000002"]),
  event(4, "candidate.created", { candidateId: "cand_0000000000000000000000" }, ["evt_0000000000000000000003"]),
  event(5, "integration.finished", { taskId: "task_0000000000000000000000", status: "pass" }, ["evt_0000000000000000000004"]),
  event(6, "candidate.gated", { candidateId: "cand_0000000000000000000000", status: "pass" }, ["evt_0000000000000000000005"]),
  event(7, "candidate.compared", { winner: "cand_0000000000000000000000" }, ["evt_0000000000000000000006"]),
];
