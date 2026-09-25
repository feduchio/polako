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
import { estimateTokens } from "../context/types.js";
import { AgentRunner, toolResultTokenCap } from "./runner.js";
import type { AgentRunnerDeps } from "./types.js";
import { EmpiricalProgressTracker } from "./progressTracker.js";
import { defaultProtocolsRoot, ProtocolRegistry } from "../protocols/loader.js";
import { progressSystemPrompt } from "../context/progressInstruction.js";

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

  it("stops a repeated empty search before the fourth model call", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 3, maxTokens: 32_000 });
    const stalled: { tool: string; repeats: number }[] = [];
    deps.onLoopStalled = (_task, info) => { stalled.push(info); };
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    provider.script("worker", Array.from({ length: 6 }, (_, index) =>
      replyWith(tool("search", { query: "commit duration", path: "src" }, `search-${index}`))));

    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected a failed run");
    expect(result.error).toBe("STALLED");
    expect(provider.calls).toHaveLength(3);
    expect(stalled).toEqual([{ tool: "search", repeats: 3 }]);
    const digest = provider.calls[2]?.messages.find((message) => message.content.includes("Earlier in this loop"))?.content ?? "";
    expect(digest).toContain('search "commit duration" (0 matches)');
    const firstResult = provider.calls[1]?.messages.find((message) => message.role === "tool")?.content ?? "";
    expect(firstResult).not.toContain('"truncated":true');
    store.close();
    await handle.destroy();
  });

  it("omits node_modules from a listing small enough to return whole", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 2, maxTokens: 8_000 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    mkdirSync(join(handle.path, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(handle.path, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    provider.script("worker", [
      replyWith(tool("list", { path: ".", recursive: true }, "list")),
      replyWith(tool("finish", { summary: "listed" }, "finish")),
    ]);
    await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    const listed = provider.calls[1]?.messages.find((message) => message.role === "tool")?.content ?? "";
    expect(listed).toContain("src/math.ts");
    expect(listed).not.toContain("left-pad");
    expect(listed).not.toContain('"truncated":true');
    store.close();
    await handle.destroy();
  });

  it("does not list node_modules and keeps a huge listing under the token cap", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 4, maxTokens: 8_000 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    mkdirSync(join(handle.path, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(handle.path, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(handle.path, "bulk"));
    for (let i = 0; i < 1_500; i += 1) {
      writeFileSync(join(handle.path, "bulk", `file-${String(i).padStart(4, "0")}.txt`), "x\n");
    }
    provider.script("worker", [
      replyWith(tool("list", { path: "node_modules", recursive: true }, "list-deps")),
      replyWith(tool("list", { path: ".", recursive: true }, "list")),
      replyWith(tool("finish", { summary: "listed" }, "finish")),
    ]);

    await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);

    const skipped = provider.calls[1]?.messages.find((message) => message.role === "tool")?.content ?? "";
    expect(skipped).toContain('"skipped":true');
    expect(skipped).not.toContain("left-pad");
    const toolMessage = provider.calls[2]?.messages.find((message) => message.role === "tool")?.content ?? "";
    expect(toolMessage).not.toContain("left-pad");
    expect(toolMessage).not.toContain("node_modules");
    expect(estimateTokens(toolMessage)).toBeLessThanOrEqual(toolResultTokenCap(8_000));
    expect(toolMessage).toContain("truncated");
    expect(toolMessage).toContain("entryCount");
    store.close();
    await handle.destroy();
  });

  it("does not stall a search whose third repeat lands on a different diff", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 6, maxTokens: 32_000 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    provider.script("worker", [
      replyWith(tool("search", { query: "commit duration", path: "src" }, "s1")),
      replyWith(tool("search", { query: "commit duration", path: "src" }, "s2")),
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" }, "w")),
      replyWith(tool("search", { query: "commit duration", path: "src" }, "s3")),
      replyWith(tool("finish", { summary: "edited" }, "finish")),
    ]);

    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("completed");
    expect(provider.calls.length).toBeGreaterThanOrEqual(5);
    store.close();
    await handle.destroy();
  });

  it("asks ripgrep to skip node_modules and .git", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 2, maxTokens: 8_000 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    const argvSeen: string[][] = [];
    const sandbox = {
      ...handle,
      run: (argv: readonly string[]) => {
        argvSeen.push([...argv]);
        return Promise.reject(new Error("spawn rg ENOENT"));
      },
    };
    provider.script("worker", [
      replyWith(tool("search", { query: "add", path: "src" }, "search")),
      replyWith(tool("finish", { summary: "searched" }, "finish")),
    ]);
    await new AgentRunner(deps).run({ ...codingTask(fixture.runId, fixture.base), touchesProductCode: false }, sandbox);
    expect(argvSeen[0]).toEqual(["rg", "-n", "--glob", "!node_modules", "--glob", "!.git", "add", "src"]);
    store.close();
    await handle.destroy();
  });

  it("windows a read that names no range, and compresses a long command transcript", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 4, maxTokens: 32_000 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    writeFileSync(join(handle.path, "src/long.ts"), `${Array.from({ length: 500 }, (_, i) => `export const line${String(i)} = ${String(i)};`).join("\n")}\n`);
    const noise = `${"noise line\n".repeat(180)}UNIQUE-MIDDLE-LINE\n${"tail line\n".repeat(40)}`;
    const sandbox = trackingSandbox(handle, () => processResult(noise));
    provider.script("worker", [
      replyWith(tool("read", { path: "src/long.ts" }, "read")),
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "cmd")),
      replyWith(tool("finish", { summary: "read" }, "finish")),
    ]);

    await new AgentRunner(deps).run({ ...codingTask(fixture.runId, fixture.base), touchesProductCode: false }, sandbox);
    const readMessage = provider.calls[1]?.messages.find((message) => message.role === "tool")?.content ?? "";
    expect(readMessage).toContain('"endLine":400');
    expect(readMessage).toContain('"truncated":true');
    expect(readMessage).not.toContain("line499");
    const commandMessage = provider.calls[2]?.messages.find((message) => message.role === "tool")?.content ?? "";
    expect(commandMessage).toContain("compressed");
    expect(commandMessage).not.toContain("UNIQUE-MIDDLE-LINE");
    store.close();
    await handle.destroy();
  });

  it("rejects a no-evidence finish on a task that does not change code", async () => {
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
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "cmd")),
      replyWith(tool("finish", { summary: "checked" }, "good")),
    ]);
    const task = { ...codingTask(fixture.runId, fixture.base), touchesProductCode: false };
    const result = await new AgentRunner(deps).run(task, handle);
    expect(result.status).toBe("completed");
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain("fresh evidence in this loop");
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
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain("fresh evidence in this loop");
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

  it("abandons a 16-turn no-op at turn 8 with lower combined scripted usage", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const baseline = harness(store, fixture.policy, { maxTurns: 16, maxTokens: 10_000 });
    const enabled = harness(store, fixture.policy, { maxTurns: 16, maxTokens: 10_000 });
    for (const provider of [baseline.provider, enabled.provider]) {
      provider.script("worker", Array.from({ length: 16 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `read-${index}`))));
    }
    const first = new ScriptedProvider("progress-a", [{ name: "a", capabilities: FAKE_CAPABILITIES.strong }]);
    const second = new ScriptedProvider("progress-b", [{ name: "b", capabilities: FAKE_CAPABILITIES.strong }]);
    first.script("a", [{ kind: "reply", content: '{"progress":0}' }]);
    second.script("b", [{ kind: "reply", content: '{"progress":0}' }]);
    const records: unknown[] = [];
    const protocols = ProtocolRegistry.load(defaultProtocolsRoot());
    enabled.deps.createProgressTracker = () => new EmpiricalProgressTracker({
      systemPrompt: progressSystemPrompt(protocols, "bugfix"),
      models: [
        { provider: first, model: { provider: "progress-a", model: "a" }, family: "a" },
        { provider: second, model: { provider: "progress-b", model: "b" }, family: "b" },
      ],
    });
    enabled.deps.onProgress = (_task, record) => records.push(record);
    const handles = await Promise.all([
      fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, branch: "polish/test/progress-off", policy: fixture.policy }),
      fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, branch: "polish/test/progress-on", policy: fixture.policy }),
    ]);
    const task = { ...codingTask(fixture.runId, fixture.base), complexity: "normal" as const };
    const without = await new AgentRunner(baseline.deps).run(task, handles[0]);
    const withProgress = await new AgentRunner(enabled.deps).run(task, handles[1]);
    const baselineTranscript = JSON.parse(store.artifacts.getText(without.transcriptRef!.sha256)) as {
      turns: unknown[];
      totalTokens: number;
    };
    const progressTranscript = JSON.parse(store.artifacts.getText(withProgress.transcriptRef!.sha256)) as {
      status: string;
      turns: unknown[];
      totalTokens: number;
      progress: unknown[];
    };
    expect(baselineTranscript.turns).toHaveLength(16);
    expect(progressTranscript).toMatchObject({ status: "ABANDONED_PROGRESS" });
    expect(progressTranscript.turns).toHaveLength(8);
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(records).toHaveLength(1);
    const progressUsage = [...first.calls, ...second.calls].length * 15;
    expect(progressTranscript.totalTokens + progressUsage).toBeLessThan(baselineTranscript.totalTokens);
    await Promise.all(handles.map((handle) => handle.destroy()));
    store.close();
  });

  it("does not let a rejected finish disable a later unanimous abandon", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 10_000 });
    provider.script("worker", [
      ...Array.from({ length: 4 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `read-before-${index}`))),
      replyWith(tool("finish", { summary: "unsupported" }, "rejected-finish")),
      ...Array.from({ length: 3 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `read-after-${index}`))),
    ]);
    let scoreCalls = 0;
    deps.createProgressTracker = () => ({
      score: () => {
        scoreCalls++;
        return Promise.resolve({
          modelScores: [
            { model: { provider: "a", model: "m" }, score: 0 },
            { model: { provider: "b", model: "m" }, score: 0 },
          ],
          mean: 0,
          stateFingerprint: "same",
        });
      },
    });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      branch: "polish/test/rejected-finish-progress",
      policy: fixture.policy,
    });
    const outcome = await new AgentRunner(deps).run(
      { ...codingTask(fixture.runId, fixture.base), complexity: "normal" },
      handle,
    );
    expect(outcome).toMatchObject({ status: "failed", error: "ABANDONED_PROGRESS" });
    expect(scoreCalls).toBe(1);
    expect(provider.calls[5]?.messages.at(-1)?.content).toContain("finish rejected");
    await handle.destroy();
    store.close();
  });

  it("does not score when live evidence changes across the checkpoint", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 10_000 });
    provider.script("worker", [
      ...Array.from({ length: 4 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `read-before-${index}`))),
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "evidence")),
      ...Array.from({ length: 3 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `read-after-${index}`))),
    ]);
    let scoreCalls = 0;
    deps.createProgressTracker = () => ({
      score: () => {
        scoreCalls++;
        return Promise.resolve(null);
      },
    });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      branch: "polish/test/evidence-progress",
      policy: fixture.policy,
    });
    await new AgentRunner(deps).run(
      { ...codingTask(fixture.runId, fixture.base), complexity: "normal" },
      handle,
    );
    expect(scoreCalls).toBe(0);
    await handle.destroy();
    store.close();
  });

  it("caps high-score plateau checks at turns 8 and 12", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 32, maxTokens: 20_000 });
    provider.script("worker", Array.from({ length: 32 }, (_, index) =>
      replyWith(tool("read", { path: "src/math.ts" }, `read-${index}`))));
    let scoreCalls = 0;
    deps.createProgressTracker = () => ({
      score: () => {
        scoreCalls++;
        return Promise.resolve({
          modelScores: [
            { model: { provider: "a", model: "m" }, score: 4 },
            { model: { provider: "b", model: "m" }, score: 4 },
          ],
          mean: 1,
          stateFingerprint: "same",
        });
      },
    });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      branch: "polish/test/high-progress",
      policy: fixture.policy,
    });
    const outcome = await new AgentRunner(deps).run(
      { ...codingTask(fixture.runId, fixture.base), complexity: "normal" },
      handle,
    );
    const transcript = JSON.parse(store.artifacts.getText(outcome.transcriptRef!.sha256)) as {
      turns: unknown[];
      progress: unknown[];
    };
    expect(transcript.turns).toHaveLength(32);
    expect(transcript.progress).toHaveLength(2);
    expect(scoreCalls).toBe(2);
    await handle.destroy();
    store.close();
  });

  it("does not score a productive rollout whose diff changes at every checkpoint", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 16, maxTokens: 10_000 });
    provider.script("worker", [
      ...Array.from({ length: 3 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `r1-${index}`))),
      replyWith(tool("write", { path: "src/math.ts", content: "export const value = 1;\n" }, "write-4")),
      ...Array.from({ length: 3 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `r2-${index}`))),
      replyWith(tool("write", { path: "src/math.ts", content: "export const value = 2;\n" }, "write-8")),
      ...Array.from({ length: 3 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `r3-${index}`))),
      replyWith(tool("write", { path: "src/math.ts", content: "export const value = 3;\n" }, "write-12")),
      replyWith(tool("finish", { summary: "done" }, "finish-13")),
    ]);
    let scoreCalls = 0;
    deps.createProgressTracker = () => ({
      score: () => {
        scoreCalls++;
        return Promise.resolve(null);
      },
    });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      branch: "polish/test/productive-progress",
      policy: fixture.policy,
    });
    const outcome = await new AgentRunner(deps).run(
      { ...codingTask(fixture.runId, fixture.base), complexity: "normal" },
      handle,
    );
    expect(outcome.status).toBe("completed");
    expect(scoreCalls).toBe(0);
    await handle.destroy();
    store.close();
  });

  it("accepts finish before scoring a plateau at turn 8", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 10_000 });
    provider.script("worker", [
      replyWith(tool("write", { path: "src/math.ts", content: "export const value = 1;\n" }, "write-1")),
      ...Array.from({ length: 6 }, (_, index) =>
        replyWith(tool("read", { path: "src/math.ts" }, `read-${index}`))),
      replyWith(tool("finish", { summary: "done" }, "finish-8")),
    ]);
    let scoreCalls = 0;
    deps.createProgressTracker = () => ({
      score: () => {
        scoreCalls++;
        return Promise.resolve(null);
      },
    });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      branch: "polish/test/finish-before-progress",
      policy: fixture.policy,
    });
    const outcome = await new AgentRunner(deps).run(
      { ...codingTask(fixture.runId, fixture.base), complexity: "normal" },
      handle,
    );
    expect(outcome.status).toBe("completed");
    expect(scoreCalls).toBe(0);
    await handle.destroy();
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
