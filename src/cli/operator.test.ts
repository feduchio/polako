import { describe, expect, it, vi } from "vitest";
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { runCli } from "./index.js";
import * as watch from "./watch.js";
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

  it("interactive run attaches watch; --detach, --json, and non-TTY do not", async () => {
    const run = sampleRun();
    mocked.mockResolvedValue(run);
    const spy = vi.spyOn(watch, "runWatch").mockResolvedValue("settled");
    const stdout = process.stdout as NodeJS.WriteStream;
    const previousTty = stdout.isTTY;
    Object.defineProperty(stdout, "isTTY", { configurable: true, value: true });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      mocked.mockClear();
      mocked.mockResolvedValue(run);
      await runCli(["run", "/tmp/p", "fix it"]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]?.runId).toBe(run.id);
      expect(mocked.mock.calls.map((call) => call[0])).toEqual(["run"]);
      // Finding 17's CLI half. An omitted `--runtime` must leave the daemon free to read
      // `polish.toml`; defaulting it here is invisible to any check of the RPC boundary.
      expect(mocked.mock.calls[0]?.[1]).not.toHaveProperty("runtime");

      spy.mockClear();
      mocked.mockClear();
      mocked.mockResolvedValue(run);
      await runCli(["run", "/tmp/p", "fix it", "--detach"]);
      expect(spy).not.toHaveBeenCalled();
      expect(mocked.mock.calls.map((call) => call[0])).toEqual(["run"]);

      mocked.mockClear();
      await runCli(["run", "/tmp/p", "fix it", "-d"]);
      expect(spy).not.toHaveBeenCalled();

      mocked.mockClear();
      await runCli(["run", "/tmp/p", "fix it", "--json"]);
      expect(spy).not.toHaveBeenCalled();

      mocked.mockClear();
      await runCli(["run", "/tmp/p", "fix it", "--runtime", "required"]);
      expect(mocked.mock.calls[0]?.[1]).toMatchObject({ runtime: "required" });
      spy.mockClear();

      Object.defineProperty(stdout, "isTTY", { configurable: true, value: false });
      mocked.mockClear();
      await runCli(["run", "/tmp/p", "fix it"]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      spy.mockRestore();
      Object.defineProperty(stdout, "isTTY", { configurable: true, value: previousTty });
    }
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

  it("plain watch emits each semantic event once across polls", async () => {
    const run = sampleRun();
    const events: Event[] = [
      sampleEvent(0, "project.discovered", { profile: { packageManager: null, framework: "node-test" } }),
      sampleEvent(1, "model.call_started", { role: "planner", model: { provider: "gemini", model: "flash" }, purpose: "council_intake_planner" }),
    ];
    let polls = 0;
    const chunks: string[] = [];
    await runWatch({
      runId: run.id,
      json: false,
      verbose: false,
      color: false,
      isTTY: true,
      plain: true,
      pollMs: 1,
      now: () => NOW,
      stdout: { write: (chunk) => { chunks.push(chunk); return true; } },
      rpc: {
        status: async () => {
          polls += 1;
          return polls >= 3 ? { ...run, phase: "DONE", control: "STOPPED" } : run;
        },
        log: async (_id, afterSeq) => (afterSeq < 0 ? events : []),
      },
    });
    const text = chunks.join("");
    const feed = text.split("\n").filter((line) => /^\d{2}:\d{2}:\d{2}/.test(line));
    expect(feed.filter((line) => line.includes("Project discovered"))).toHaveLength(1);
    expect(feed.filter((line) => line.includes("→ planner"))).toHaveLength(1);
  });

  it("TTY watch enters and leaves the alternate screen and restores the cursor", async () => {
    const run = sampleRun();
    const chunks: string[] = [];
    const abort = new AbortController();
    const done = runWatch({
      runId: run.id,
      json: false,
      verbose: false,
      color: false,
      isTTY: true,
      pollMs: 20,
      rows: 40,
      signal: abort.signal,
      now: () => NOW,
      stdout: { write: (chunk) => { chunks.push(chunk); return true; }, rows: 40 },
      rpc: {
        status: async () => run,
        log: async () => [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await done;
    const text = chunks.join("");
    expect(text).toContain("\x1b[?1049h");
    expect(text).toContain("\x1b[?25l");
    expect(text).toContain("\x1b[?25h");
    expect(text).toContain("\x1b[?1049l");
    expect(text.indexOf("\x1b[?1049h")).toBeLessThan(text.lastIndexOf("\x1b[?1049l"));
  });

  it("Ctrl-C from watch detaches without execution-control RPC", async () => {
    const run = sampleRun();
    const methods: string[] = [];
    const abort = new AbortController();
    const done = runWatch({
      runId: run.id,
      json: false,
      verbose: false,
      color: false,
      isTTY: true,
      pollMs: 15,
      rows: 24,
      signal: abort.signal,
      now: () => NOW,
      stdout: { write: () => true, rows: 24 },
      rpc: {
        status: async () => {
          methods.push("status");
          return run;
        },
        log: async () => {
          methods.push("log");
          return [];
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    abort.abort();
    const reason = await done;
    expect(reason).toBe("detached");
    expect(methods.every((method) => method === "status" || method === "log")).toBe(true);
    expect(methods.length).toBeGreaterThan(0);
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
