import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { Git } from "../sandbox/git.js";
import { RpcServer, rpcCall } from "./rpc.js";
import { DaemonService } from "./service.js";

describe("daemon RPC", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips JSON-RPC over a temporary unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-rpc-"));
    dirs.push(dir);
    const socket = join(dir, "polish.sock");
    const server = new RpcServer(socket, {
      handle: (method, params) => Promise.resolve({ method, value: params["value"] }),
    });
    await server.listen();

    await expect(rpcCall(socket, "echo", { value: 42 })).resolves.toEqual({
      method: "echo",
      value: 42,
    });

    await server.close();
  });

  it("returns handler failures to the client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-rpc-"));
    dirs.push(dir);
    const socket = join(dir, "polish.sock");
    const server = new RpcServer(socket, {
      handle: () => Promise.reject(new Error("planned failure")),
    });
    await server.listen();
    await expect(rpcCall(socket, "fail")).rejects.toThrow("planned failure");
    await server.close();
  });

  it("pause/resume/stop round-trip through an in-process daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-control-"));
    dirs.push(dir);
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }));
    const git = await Git.init(repoDir);
    await git.commitAll("init");

    const provider = new ScriptedProvider("scripted", [
      { name: "worker", capabilities: FAKE_CAPABILITIES.frontier },
      { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
      { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
    ]);
    const clock = new FakeClock(1_700_000_000_000);
    const home = join(dir, "home");
    const service = new DaemonService({ home, clock, providers: [provider], tickMs: 1 });
    const socket = join(dir, "polish.sock");
    const server = new RpcServer(socket, service);
    await server.listen();

    const created = await rpcCall<{ id: string; runBranch: string }>(socket, "run", {
      project: repoDir,
      mission: "noop",
      runtime: "off",
    });

    const paused = await rpcCall<{ control: string }>(socket, "pause", { runId: created.id });
    expect(["PAUSE_REQUESTED", "PAUSED"]).toContain(paused.control);

    const resumed = await rpcCall<{ control: string }>(socket, "resume", { runId: created.id });
    expect(resumed.control).toBe("RUNNING");

    const stopped = await rpcCall<{ control: string }>(socket, "stop", { runId: created.id });
    expect(["STOP_REQUESTED", "STOPPED"]).toContain(stopped.control);

    await server.close();
    await service.close();
  });
});
