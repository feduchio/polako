import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { humanizeModel, projectActivity, projectRunStatus } from "./project.js";
import { renderRunStatus, renderWatchFrame } from "./render.js";
import { openStore } from "../store/index.js";
import { id } from "../shared/ids.js";

const NOW = 1_700_000_000_000;

describe("RunObserver projection", () => {
  it("renders an active model call from a start event without a completion", () => {
    const run = baseRun({ phase: "INTERPRETING_MISSION", control: "RUNNING" });
    const events = [
      evt(0, "model.call_started", { callId: "call_1", role: "judge", model: { provider: "openrouter", model: "glm" }, purpose: "council_intake_judge" }, NOW - 8_000),
    ];
    const view = projectRunStatus(run, events, NOW);
    expect(view.active?.kind).toBe("model");
    expect(view.active?.role).toBe("judge");
    expect(view.council.find((role) => role.role === "judge")?.state).toBe("running");
    expect(renderRunStatus(view)).toContain("judge");
    expect(view.warning).toBeNull();
  });

  it("renders retry/backoff while a call is waiting", () => {
    const run = baseRun({ phase: "INTERPRETING_MISSION", control: "RUNNING" });
    const events = [
      evt(0, "model.call_started", { callId: "call_1", role: "judge", model: { provider: "openrouter", model: "glm" } }, NOW - 5_000),
      evt(1, "model.retry_scheduled", { callId: "call_1", role: "judge", model: { provider: "openrouter", model: "glm" }, attempt: 1, maxAttempts: 2, delayMs: 7_000, retryAt: NOW + 2_000, errorKind: "rate_limit" }, NOW - 1_000),
    ];
    const view = projectRunStatus(run, events, NOW);
    expect(view.waiting?.kind).toBe("retry");
    expect(view.council.find((role) => role.role === "judge")?.state).toBe("retry");
    expect(renderRunStatus(view)).toContain("retry");
  });

  it("renders a paused provider-unavailable run from persisted events", () => {
    const run = baseRun({ phase: "INTERPRETING_MISSION", control: "PAUSED" });
    const events = [
      evt(0, "model.call_started", { callId: "call_1", role: "judge", model: { provider: "openrouter", model: "glm" } }, NOW - 20_000),
      evt(1, "model.call", { callId: "call_1", role: "judge", model: { provider: "openrouter", model: "glm" }, ok: false, error: "429" }, NOW - 10_000),
      evt(2, "council.unavailable", { role: "judge", attempted: [{ model: { provider: "openrouter", model: "glm" }, kind: "rate_limit" }], automaticRetryScheduled: false, manualResumePossible: true }, NOW - 9_000),
      evt(3, "run.control_changed", { run: { ...run, control: "PAUSED" } }, NOW - 8_000),
    ];
    const view = projectRunStatus(run, events, NOW);
    expect(view.stallKind).toBe("unavailable");
    expect(view.waiting?.kind).toBe("unavailable");
    expect(view.waiting?.manualResumePossible).toBe(true);
    expect(renderRunStatus(view)).toContain("unavailable");
  });

  it("warns when RUNNING with no active operation and stale last activity", () => {
    const run = baseRun({ phase: "INTERPRETING_MISSION", control: "RUNNING", createdAt: NOW - 600_000 });
    const events = [evt(0, "run.phase_changed", { to: "INTERPRETING_MISSION" }, NOW - 120_000)];
    const view = projectRunStatus(run, events, NOW);
    expect(view.stallKind).toBe("stale");
    expect(view.warning).toMatch(/no active operation/i);
  });

  it("D: genuine NEEDS_HUMAN status shows the human question", () => {
    const run = baseRun({
      phase: "NEEDS_HUMAN",
      terminalReason: {
        code: "ambiguous_intent",
        summary: "Compatibility is unclear.",
        question: "Which API should remain compatible?",
        options: ["Public API", "Internal API"],
      },
    });
    const events = [
      evt(0, "supervisor.decision", { decision: "NEEDS_HUMAN", reason: "blocking ambiguity" }, NOW),
      evt(1, "report.generated", { kind: "needs_human", question: "Which API should remain compatible?", options: ["Public API", "Internal API"] }, NOW + 1),
      evt(2, "run.phase_changed", { to: "NEEDS_HUMAN", run: { phase: "NEEDS_HUMAN", terminalReason: run.terminalReason } }, NOW + 2),
    ];
    const view = projectRunStatus(run, events, NOW + 3);
    expect(view.humanRequest?.question).toBe("Which API should remain compatible?");
    expect(view.waiting?.kind).toBe("human");
    expect(view.phase).toBe("NEEDS_HUMAN");
    expect(view.control).toBe("RUNNING");
    const rendered = renderRunStatus(view);
    expect(rendered).toContain("Which API should remain compatible?");
    expect(rendered).toContain("HUMAN");
    expect(rendered).toContain("waiting for input");
    expect(rendered).not.toContain("NEEDS_HUMAN / RUNNING");
    expect(JSON.stringify(view)).toContain('"phase":"NEEDS_HUMAN"');
    expect(JSON.stringify(view)).toContain('"control":"RUNNING"');
    expect(projectActivity(events).map((line) => line.text).join("\n")).toContain("Needs human · Which API should remain compatible?");
  });

  it("historical schema-invalid NEEDS_HUMAN is shown as output contract, not a human question", () => {
    const run = baseRun({ phase: "NEEDS_HUMAN" });
    const events = [
      evt(0, "supervisor.decision", {
        decision: "NEEDS_HUMAN",
        reason: "planner interpretation requirements failed schema validation",
        rationale: "planner: bounded | scope: unambiguous | judge: verifiable",
      }, NOW),
      evt(1, "report.generated", {
        kind: "needs_human",
        question: "The planner did not produce a valid requirement set. How should the mission be interpreted?",
        options: ["Restate the mission with explicit acceptance criteria"],
      }, NOW + 1),
      evt(2, "run.phase_changed", { to: "NEEDS_HUMAN", run: { phase: "NEEDS_HUMAN" } }, NOW + 2),
    ];
    const view = projectRunStatus(run, events, NOW + 3);
    expect(view.waiting?.kind).toBe("output_contract");
    expect(view.humanRequest).toBeNull();
    const rendered = renderRunStatus(view);
    expect(rendered).toContain("output contract");
    expect(rendered).toContain("not a human question");
    expect(rendered).not.toContain("How should the mission be interpreted?");
  });

  it("human log summarizes planner output-invalid and repair", () => {
    const events = [
      evt(0, "model.output_invalid", { role: "planner", summary: "$.requirements[0] expected object" }, NOW),
      evt(1, "model.output_repair_attempted", { role: "planner", attempt: 1, maxAttempts: 1 }, NOW + 1),
      evt(2, "model.fallback_selected", { role: "planner", to: { provider: "openrouter", model: "minimax-m3" } }, NOW + 2),
    ];
    const text = projectActivity(events).map((line) => line.text).join("\n");
    expect(text).toContain("! planner output invalid · $.requirements[0] expected object");
    expect(text).toContain("↻ repair 1/1");
    expect(text).toContain("⇢ fallback");
    expect(text).toMatch(/Minimax M3|MiniMax M3/i);
  });

  it("preserves OpenRouter :free model identity instead of rendering Free", () => {
    expect(humanizeModel("minimax/minimax-m3:free")).toBe("MiniMax M3");
    expect(humanizeModel("dots-studio/dots-3-note-preview:free")).toBe("Dots 3 Note Preview");
    expect(humanizeModel("z-ai/glm-5.2:free")).toBe("GLM 5.2");
    expect(humanizeModel("openrouter:minimax/minimax-m3:free")).toBe("MiniMax M3");
  });

  it("activity lines include council stage from purpose", () => {
    const events = [
      evt(0, "model.call_started", { role: "planner", model: { provider: "gemini", model: "gemini-3.8-flash" }, purpose: "council_intake_planner" }, NOW),
      evt(1, "model.call_started", { role: "planner", model: { provider: "gemini", model: "gemini-3.8-flash" }, purpose: "council_decompose_planner" }, NOW + 1),
    ];
    const text = projectActivity(events).map((line) => line.text).join("\n");
    expect(text).toContain("intake");
    expect(text).toContain("decompose");
  });

  it("watch fixture renders semantic transitions in order", () => {
    const events = [
      evt(0, "project.discovered", { profile: { packageManager: "pnpm", framework: "vitest" } }, NOW),
      evt(1, "shell.command_started", { command: ["pnpm", "test"], check: "test" }, NOW + 1_000),
      evt(2, "baseline.snapshotted", { baseline: { commitHash: "abc", checks: [{ status: "pass" }] } }, NOW + 2_000),
      evt(3, "run.phase_changed", { to: "INTERPRETING_MISSION", run: { phase: "INTERPRETING_MISSION" } }, NOW + 3_000),
      evt(4, "model.call_started", { role: "planner", model: { provider: "gemini", model: "gemini-3.8-flash" } }, NOW + 4_000),
      evt(5, "model.call", { role: "planner", model: { provider: "gemini", model: "gemini-3.8-flash" }, ok: true, latencyMs: 4500 }, NOW + 5_000),
      evt(6, "model.call_started", { role: "judge", model: { provider: "openrouter", model: "z-ai/glm-5.2:free" } }, NOW + 6_000),
      evt(7, "model.retry_scheduled", { role: "judge", delayMs: 4000, errorKind: "rate_limit" }, NOW + 7_000),
      evt(8, "model.fallback_selected", { role: "judge", to: { provider: "gemini", model: "gemini-3.8-flash" } }, NOW + 8_000),
    ];
    const lines = projectActivity(events).map((line) => line.text);
    expect(lines[0]).toMatch(/Project discovered/);
    expect(lines.join("\n")).toContain("→ planner");
    expect(lines.join("\n")).toContain("⇢ fallback");
    const view = projectRunStatus(baseRun({ phase: "INTERPRETING_MISSION", control: "RUNNING" }), events, NOW + 9_000);
    const frame = renderWatchFrame(view, projectActivity(events));
    expect(frame).not.toContain("{");
    expect(frame).toContain("Polish ·");
  });

  it("rebuilds status from persisted events after reopening the store", () => {
    const home = mkdtempSync(join(tmpdir(), "polish-observe-restart-"));
    try {
      const store = openStore({ home });
      const run = baseRun();
      store.events.append([
        {
          id: id("evt", NOW),
          runId: run.id,
          ts: NOW - 5_000,
          type: "model.call_started",
          payload: { callId: "call_1", role: "judge", model: { provider: "openrouter", model: "glm" } },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
      ]);
      store.close();
      const reopened = openStore({ home });
      const view = projectRunStatus(run, reopened.events.list(run.id), NOW);
      expect(view.active?.role).toBe("judge");
      reopened.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * A partially priced run is the common case on the free tier, and a bare total there is a lower
   * bound the operator cannot tell from a real one.
   */
  /**
   * MC2 defines "unpriced" as: `usage` present **and** `costUsd` not a finite number.
   *
   * Driven one shape at a time. An aggregate fixture lets two wrong classifications cancel — the
   * count that reuses the neighbouring fold was right only because deduplicating one call and
   * misclassifying one negative price offset each other — and a `usd` **sum** cannot see a priced
   * zero at all, since zero contributes nothing to it. In isolation neither can hide.
   */
  describe("usdUsage classifies one call at a time", () => {
    const withUsage = (costUsd: unknown): Record<string, unknown> =>
      ({ inputTokens: 4, outputTokens: 1, ...(costUsd === "absent" ? {} : { costUsd }) });
    const viewOf = (payload: Record<string, unknown>, type = "model.call"): ReturnType<typeof projectRunStatus> =>
      projectRunStatus(baseRun({ phase: "REVIEWING", control: "RUNNING" }), [evt(0, type, payload, NOW - 9_000)], NOW);

    // Reported usage, no usable price. Each shape on its own, so a predicate that recognises only
    // some of them cannot be covered for by the others.
    for (const [name, costUsd] of [
      ["null", null],
      ["absent", "absent"],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a string", "0.5"],
      ["a boolean", true],
    ] as const) {
      it(`counts a call whose price is ${name}`, () => {
        const view = viewOf({ callId: "c", usage: withUsage(costUsd) });
        expect(view.resources.unpricedCalls).toBe(1);
        expect(view.resources.usd).toBeNull();
      });
    }

    // Finite prices. `0` is the one a sum cannot observe, and the free tier reports it.
    for (const [name, costUsd] of [["positive", 0.25], ["zero", 0], ["negative", -0.05]] as const) {
      it(`prices a call whose cost is ${name}`, () => {
        const view = viewOf({ callId: "c", usage: withUsage(costUsd) });
        expect(view.resources.unpricedCalls).toBe(0);
        expect(view.resources.usd).toBe(costUsd);
      });
    }

    // No usage at all: it spent nothing, so it is not unpriced spend.
    for (const [name, usage] of [["null", null], ["absent", "absent"]] as const) {
      it(`ignores a call whose usage is ${name}`, () => {
        const view = viewOf({ callId: "c", ...(usage === "absent" ? {} : { usage }) });
        expect(view.resources.unpricedCalls).toBe(0);
        expect(view.resources.usd).toBeNull();
      });
    }

    it("counts events, not unique call ids", () => {
      const view = projectRunStatus(baseRun({ phase: "REVIEWING", control: "RUNNING" }), [
        evt(0, "model.call", { callId: "same", usage: withUsage(null) }, NOW - 9_000),
        evt(1, "model.call", { callId: "same", usage: withUsage(null) }, NOW - 8_000),
      ], NOW);
      expect(view.resources.unpricedCalls).toBe(2);
    });

    it("ignores an event that is not a completed model.call", () => {
      expect(viewOf({ callId: "c", usage: withUsage(null) }, "model.call_started").resources.unpricedCalls).toBe(0);
    });
  });

  it("counts a call as unpriced only when it reported usage without a finite price", () => {
    const run = baseRun({ phase: "REVIEWING", control: "RUNNING" });
    const usage = (costUsd: unknown): Record<string, unknown> =>
      ({ inputTokens: 4, outputTokens: 1, ...(costUsd === "absent" ? {} : { costUsd }) });
    const view = projectRunStatus(run, [
      // Three priced calls. `0` and a negative are finite, so MC2 prices them: the free tier
      // really does report `costUsd: 0`, and the neighbouring fold's `finiteNonnegative` is the
      // predicate an implementer would reach for by mistake.
      evt(0, "model.call", { callId: "priced", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25 } }, NOW - 9_000),
      evt(1, "model.call", { callId: "priced-zero", usage: usage(0) }, NOW - 8_950),
      evt(2, "model.call", { callId: "priced-negative", usage: usage(-0.05) }, NOW - 8_920),
      // Six events of "reported usage, no usable price". Each must count — including the repeated
      // `callId`, because `usdUsage` folds events and does not deduplicate the way
      // `foldModelCallUsage` deliberately does.
      evt(3, "model.call", { callId: "u-null", usage: usage(null) }, NOW - 8_900),
      evt(4, "model.call", { callId: "u-null", usage: usage(null) }, NOW - 8_850),
      evt(5, "model.call", { callId: "u-absent", usage: usage("absent") }, NOW - 8_800),
      evt(6, "model.call", { callId: "u-nan", usage: usage(Number.NaN) }, NOW - 8_700),
      evt(7, "model.call", { callId: "u-inf", usage: usage(Number.POSITIVE_INFINITY) }, NOW - 8_600),
      evt(8, "model.call", { callId: "u-str", usage: usage("0.5") }, NOW - 8_500),
      // Two calls that reported no usage at all. They spent nothing, so they are not unpriced
      // spend. The count differs from the class above, so swapping the two is visible.
      evt(9, "model.call", { callId: "no-usage-a", usage: null }, NOW - 8_400),
      evt(10, "model.call", { callId: "no-usage-b" }, NOW - 8_300),
    ], NOW);
    expect(view.resources.usd).toBeCloseTo(0.2, 10);
    expect(view.resources.unpricedCalls).toBe(6);
    expect(renderRunStatus(view)).toContain("(+6 unpriced)");
  });

  it("says nothing about unpriced calls when every call carried a price", () => {
    const run = baseRun({ phase: "REVIEWING", control: "RUNNING" });
    const view = projectRunStatus(run, [
      evt(0, "model.call", { callId: "c1", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25 } }, NOW - 9_000),
    ], NOW);
    expect(view.resources.unpricedCalls).toBe(0);
    expect(renderRunStatus(view)).not.toContain("unpriced");
  });
});

function baseRun(patch: Partial<Run> = {}): Run {
  return {
    id: "run_01m1mfzvkbqjfa6mgyjvbz",
    missionId: "msn_0000000000000000000000",
    projectPath: "/Users/fedorsvetlov/polish-selfhost-target",
    runBranch: "polish/run",
    phase: "INTERPRETING_MISSION",
    control: "RUNNING",
    currentCheckpointHash: "4ae18472c864",
    baselineId: null,
    interpretationId: null,
    createdAt: NOW - 88_000,
    updatedAt: NOW,
    terminalReason: null,
    ...patch,
  };
}

function evt(seq: number, type: string, payload: Record<string, unknown>, ts: number): Event {
  return {
    schemaVersion: 1,
    id: `evt_${String(seq).padStart(22, "0")}`,
    runId: "run_01m1mfzvkbqjfa6mgyjvbz",
    seq,
    ts,
    type,
    payload,
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  };
}
