import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliDaemonCall } from "../cli/index.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { id } from "../shared/ids.js";
import { openStore } from "../store/index.js";

const cleanup: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("polish cost", () => {
  it("reports a completed historical run from persisted events without live budget state", async () => {
    const home = mkdtempSync(join(tmpdir(), "polish-economics-"));
    cleanup.push(home);
    const store = openStore({ home });
    const run = completedRun();
    const events = [
      event(run.id, 1, "run.created", { run }),
      event(run.id, 2, "model.call", {
        callId: "historical-call",
        role: "worker",
        purpose: "agent_run",
        taskId: null,
        ok: true,
        usage: { inputTokens: 12, outputTokens: 3, costUsd: 0 },
      }),
    ];
    store.events.append(events);
    expect(store.repos.runs.get(run.id)).toEqual(run);

    // This is the production command seam, backed only by persisted status/log data. No daemon
    // engine or BudgetTracker exists in the test.
    const daemonCall: CliDaemonCall = <T>(method: string): Promise<T> => {
      if (method === "status") return Promise.resolve(store.repos.runs.get(run.id) as T);
      if (method === "log") return Promise.resolve(store.events.list(run.id) as T);
      return Promise.reject(new Error(`unexpected method ${method}`));
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["cost", run.id], { callDaemon: daemonCall });

    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain(`Run ${run.id}`);
    expect(output).toContain("Outcome: DONE (terminal)");
    expect(output).toContain("Tokens: 15 total = 12 input + 3 output");
    expect(output).toContain("worker: 15 = 12 in + 3 out");
    store.close();
  });

  it("prints JSON and rejects an unknown run id through the same transport", async () => {
    const run = completedRun();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const daemonCall: CliDaemonCall = <T>(method: string): Promise<T> => {
      if (method === "status") return Promise.reject(new Error("run missing not found"));
      return Promise.resolve([] as T);
    };

    await expect(runCli(["cost", "missing", "--json"], { callDaemon: daemonCall }))
      .rejects.toThrow("run missing not found");
    expect(write).not.toHaveBeenCalled();

    const jsonCall: CliDaemonCall = <T>(method: string): Promise<T> =>
      Promise.resolve((method === "status" ? run : []) as T);
    await runCli(["cost", run.id, "--json"], { callDaemon: jsonCall });
    const parsed = JSON.parse(write.mock.calls.map((call) => String(call[0])).join("")) as {
      runId: string;
      tokens: { totalTokens: number };
    };
    expect(parsed).toEqual(expect.objectContaining({
      runId: run.id,
      tokens: expect.objectContaining({ totalTokens: 0 }),
    }));
  });
});

function completedRun(): Run {
  return {
    id: id("run", 1),
    missionId: id("msn", 1),
    projectPath: "/tmp/project",
    runBranch: "polish/run",
    phase: "DONE",
    control: "RUNNING",
    currentCheckpointHash: null,
    baselineId: null,
    interpretationId: null,
    createdAt: 1,
    updatedAt: 2,
    terminalReason: { code: "converged", summary: "done" },
  };
}

function event(runId: string, seq: number, type: string, payload: Record<string, unknown>): Event {
  return {
    schemaVersion: 1,
    id: id("evt", seq),
    runId,
    seq,
    ts: seq,
    type,
    payload,
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
}
