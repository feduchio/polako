import { describe, expect, it, vi } from "vitest";
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { runCli } from "./index.js";
import { runWatch } from "./watch.js";

const NOW = 1_700_000_000_000;

vi.mock("./client.js", () => ({
  callDaemon: vi.fn(),
}));

import { callDaemon } from "./client.js";

const mocked = vi.mocked(callDaemon);

describe("operator CLI presentation", () => {
  it("status default is human text and --json is the machine view", async () => {
    const run = sampleRun();
    const events = [
      sampleEvent(0, "model.call_started", { callId: "call_1", role: "planner", model: { provider: "gemini", model: "gemini-3.8-flash" } }),
    ];
    mocked.mockImplementation(async (method: string) => {
      if (method === "status") return run;
      if (method === "log") return events;
      throw new Error(method);
    });
    const human = await capture(["status", run.id]);
    expect(human).toContain("Polish ·");
    expect(human).toContain("INTERPRETING_MISSION");
    expect(human.trim().startsWith("{")).toBe(false);

    const json = await capture(["status", run.id, "--json"]);
    expect(json.trim().startsWith("{")).toBe(true);
    expect(json).not.toContain("Polish ·");
    const parsed = JSON.parse(json) as { runId: string; phase: string };
    expect(parsed.runId).toBe(run.id);
    expect(parsed.phase).toBe("INTERPRETING_MISSION");
  });

  it("watch follows a fixture and emits semantic lines in order", async () => {
    const run = sampleRun();
    const events: Event[] = [
      sampleEvent(0, "project.discovered", { profile: { packageManager: "pnpm", framework: "vitest" } }),
      sampleEvent(1, "model.call_started", { role: "planner", model: { provider: "gemini", model: "flash" } }),
      sampleEvent(2, "model.call", { role: "planner", model: { provider: "gemini", model: "flash" }, ok: true, latencyMs: 1000 }),
    ];
    const chunks: string[] = [];
    await runWatch({
      runId: run.id,
      json: false,
      verbose: true,
      color: false,
      isTTY: false,
      pollMs: 1,
      now: () => NOW,
      stdout: { write: (chunk) => { chunks.push(chunk); return true; } },
      rpc: {
        status: async () => ({ ...run, phase: "DONE", control: "STOPPED" }),
        log: async () => events,
      },
    });
    const text = chunks.join("");
    expect(text).toContain("Project discovered");
    expect(text.indexOf("Project discovered")).toBeLessThan(text.indexOf("→ planner"));
  });

  it("log --json emits raw canonical events", async () => {
    const run = sampleRun();
    const events = [sampleEvent(0, "model.call", { ok: true, role: "planner" })];
    mocked.mockImplementation(async (method: string) => {
      if (method === "log") return events;
      if (method === "status") return run;
      throw new Error(method);
    });
    const out = await capture(["log", run.id, "--json"]);
    const parsed = JSON.parse(out.trim()) as Event;
    expect(parsed.type).toBe("model.call");
    expect(out).not.toContain("✓ planner");
  });
});

async function capture(argv: string[]): Promise<string> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runCli(argv);
  const output = write.mock.calls.map((call) => String(call[0])).join("");
  write.mockRestore();
  return output;
}

function sampleRun(): Run {
  return {
    id: "run_01m1mfzvkbqjfa6mgyjvbz",
    missionId: "msn_0000000000000000000000",
    projectPath: "/tmp/target",
    runBranch: "polish/run",
    phase: "INTERPRETING_MISSION",
    control: "RUNNING",
    currentCheckpointHash: "abc",
    baselineId: null,
    interpretationId: null,
    createdAt: NOW - 10_000,
    updatedAt: NOW,
    terminalReason: null,
  };
}

function sampleEvent(seq: number, type: string, payload: Record<string, unknown>): Event {
  return {
    schemaVersion: 1,
    id: `evt_${String(seq).padStart(22, "0")}`,
    runId: "run_01m1mfzvkbqjfa6mgyjvbz",
    seq,
    ts: NOW + seq * 1000,
    type,
    payload,
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  };
}
