import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../broker/types.js";
import { SecretStore } from "../broker/secrets.js";
import { defaultConfig } from "../domain/config.js";
import type { Task } from "../domain/task.js";
import { BasicIntel } from "../intel/basic.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import type { ProcessResult } from "../sandbox/process.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { AgentRunner } from "./runner.js";
import type { AgentRunnerDeps } from "./types.js";

const SECRET = "agent-runner-super-secret";
const NOW = 1_700_000_000_000;
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("AgentRunner", () => {
  it("finishes with fresh loop evidence across read/write/patch/search/run_command and persists a scrubbed transcript", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy);
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      branch: "polish/test/candidate",
      policy: fixture.policy,
    });

    provider.script("worker", [
      replyWith(tool("read", { path: "src/math.ts" }, "read")),
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" }, "write")),
      replyWith(tool("apply_patch", { path: "src/math.ts", oldText: "a + b", newText: "a + b + 0" }, "patch")),
      replyWith(tool("search", { query: "add", path: "src" }, "search")),
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "cmd")),
      replyWith(tool("finish", { summary: "done" }, "finish")),
    ]);

    const task = codingTask(fixture.runId, fixture.base);
    const result = await new AgentRunner(deps).run(task, handle);

    expect(result.status).toBe("completed");
    expect(provider.calls[0]?.tools?.map((spec) => spec.name)).toEqual([
      "read", "list", "search", "repo_intel", "write", "apply_patch", "run_command", "request_context", "finish",
    ]);
    expect(readFileSync(join(handle.path, "src/math.ts"), "utf8")).toContain("a + b + 0");
    expect(result.transcriptRef).toBeDefined();
    const transcript = store.artifacts.getText(result.transcriptRef!.sha256);
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript).not.toContain(SECRET);
    expect(JSON.parse(transcript)).toMatchObject({ status: "FINISHED", turns: expect.any(Array) });
    store.close();
    await handle.destroy();
  });

  it("rejects finish without fresh loop evidence and lets the model recover", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy);
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });

    provider.script("worker", [
      replyWith(tool("finish", { summary: "claim only" }, "bad")),
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" }, "write")),
      replyWith(tool("finish", { summary: "now evidenced" }, "good")),
    ]);

    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("completed");
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain("finish rejected");
    store.close();
    await handle.destroy();
  });

  it("rejects finish for coding tasks when the worktree diff vs base is empty", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy);
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });

    provider.script("worker", [
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "cmd")),
      replyWith(tool("finish", { summary: "command only" }, "finish")),
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" }, "write")),
      replyWith(tool("finish", { summary: "now changed" }, "finish2")),
    ]);

    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("completed");
    expect(provider.calls[2]?.messages.at(-1)?.content).toContain("non-empty worktree diff");
    store.close();
    await handle.destroy();
  });

  it("terminates with BUDGET_EXCEEDED before accepting an over-budget finish", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTokens: 5 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });

    provider.script("worker", [{
      kind: "reply",
      content: "",
      toolCalls: [tool("finish", { summary: "too expensive" }, "finish")],
      usage: { inputTokens: 4, outputTokens: 2 },
    }]);

    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toBe("BUDGET_EXCEEDED");
    store.close();
    await handle.destroy();
  });

  it("denies writes and patches that escape the worktree", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy);
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });

    provider.script("worker", [
      replyWith(tool("write", { path: "../escaped.txt", content: "owned" }, "write")),
      replyWith(tool("apply_patch", { path: "../escaped.txt", oldText: "owned", newText: "still-owned" }, "patch")),
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 2;\n" }, "good-write")),
      replyWith(tool("finish", { summary: "recovered" }, "finish")),
    ]);

    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("completed");
    expect(existsSync(join(fixture.repoDir, "escaped.txt"))).toBe(false);
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain("path escapes sandbox");
    store.close();
    await handle.destroy();
  });

  it("returns command policy denial to the model without executing the command", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy);
    let executions = 0;
    const handle = trackingSandbox(await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    }), () => {
      executions += 1;
      return processResult(`result ${SECRET}`);
    });

    provider.script("worker", [
      replyWith(tool("run_command", { argv: ["rm", "-rf", "."] }, "command")),
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" }, "write")),
      replyWith(tool("finish", { summary: "recovered" }, "finish")),
    ]);

    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("completed");
    expect(executions).toBe(0);
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain("command not in allowlist");
    store.close();
    await handle.destroy();
  });

  it("creates fresh runner instances so loop state cannot leak across siblings", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy);
    const seen: AgentRunner[] = [];

    provider.script("worker", [
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 0;\n" }, "write-0")),
      replyWith(tool("finish", { summary: "done-0" }, "finish-0")),
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" }, "write-1")),
      replyWith(tool("finish", { summary: "done-1" }, "finish-1")),
    ]);

    const task = codingTask(fixture.runId, fixture.base);
    const handles = await Promise.all([
      fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, branch: "polish/test/a", policy: fixture.policy }),
      fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, branch: "polish/test/b", policy: fixture.policy }),
    ]);

    for (const handle of handles) {
      const runner = new AgentRunner(deps);
      seen.push(runner);
      const outcome = await runner.run(task, handle);
      expect(outcome.status).toBe("completed");
      expect(outcome.transcriptRef).toBeDefined();
      expect(store.artifacts.getText(outcome.transcriptRef!.sha256).length).toBeGreaterThan(0);
      await handle.destroy();
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[0]?.messages).not.toBe(provider.calls[2]?.messages);
    store.close();
  });
});

function harness(
  store: Store,
  policy: CommandPolicy,
  overrides: Partial<AgentRunnerDeps> = {},
): { provider: ScriptedProvider; deps: AgentRunnerDeps } {
  const provider = new ScriptedProvider("scripted", [{ name: "worker", capabilities: FAKE_CAPABILITIES.strong }]);
  return {
    provider,
    deps: {
      complete: (request) => provider.complete(request),
      artifacts: store.artifacts,
      model: { provider: "scripted", model: "worker" },
      commandPolicy: policy,
      maxTurns: 8,
      maxTokens: 1_000,
      redact: SecretStore.fromValues({ TEST_API_KEY: SECRET }).redact.bind(SecretStore.fromValues({ TEST_API_KEY: SECRET })),
      createIntelligence: (path) => new BasicIntel(path),
      ...overrides,
    },
  };
}

function codingTask(runId: string, baseCheckpointHash: string): Task {
  return {
    id: id("task", NOW),
    runId,
    title: "Fix add",
    description: "Fix add in src/math.ts",
    kind: "bugfix",
    origin: { kind: "mission_requirement", interpretationId: id("mint", NOW), requirementRef: "R1" },
    acceptance: ["add(1,1)===2"],
    complexity: "trivial",
    baseCheckpointHash,
    dependsOn: [],
    state: "READY",
    attempts: 0,
    touchesProductCode: true,
    selectedCandidateId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function tool(name: string, args: unknown, idValue: string): ToolCall {
  return { id: idValue, name, arguments: JSON.stringify(args) };
}

function replyWith(call: ToolCall) {
  return { kind: "reply" as const, content: "", toolCalls: [call] };
}

function processResult(stdout: string): ProcessResult {
  return {
    argv: ["node", "-e", "console.log('ok')"],
    cwd: ".",
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    startedAt: 1,
  };
}

function trackingSandbox(handle: SandboxHandle, run: () => ProcessResult): SandboxHandle {
  return {
    ...handle,
    run: async () => run(),
  };
}

async function repositoryFixture(): Promise<{
  root: string;
  repoDir: string;
  base: string;
  runId: string;
  sandbox: WorktreeSandbox;
  policy: CommandPolicy;
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-agent-"));
  const repoDir = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(repoDir);
  const git = await Git.init(repoDir);
  mkdirSync(join(repoDir, "src"));
  writeFileSync(join(repoDir, "src/math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  const base = await git.commitAll("base");
  if (base === null) throw new Error("fixture base commit missing");
  const runId = id("run");
  const policy = CommandPolicy.forProject(
    [["node", "-e", "console.log('ok')"]],
    null,
    false,
    { search: true },
  );
  return {
    root,
    repoDir,
    base,
    runId,
    sandbox: new WorktreeSandbox(repoDir, worktrees, defaultConfig().sandbox),
    policy,
  };
}
