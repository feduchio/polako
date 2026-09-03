import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { projectActivity, projectRunStatus } from "./project.js";
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
