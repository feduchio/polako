import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompletionRequest, ToolCall } from "../broker/types.js";
import { SecretStore } from "../broker/secrets.js";
import { defaultConfig } from "../domain/config.js";
import type { Task } from "../domain/task.js";
import { BasicIntel } from "../intel/basic.js";
import { FAKE_CAPABILITIES, reply, ScriptedProvider } from "../providers/scripted.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import type { ProcessResult } from "../sandbox/process.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { estimateTokens } from "../context/types.js";
import { AgentRunner, toolResultTokenBudget } from "./runner.js";
import type { AgentRunnerDeps } from "./types.js";
import { AGENT_TOOL_DEFINITIONS, createAgentTools, createLoopEvidence, pageLines } from "./tools.js";
import { anchorOf } from "./hashline.js";
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
      replyWith(tool("edit", {
        path: "src/math.ts",
        edits: [{ op: "replace", start: anchorOf(1, "export const add = (a: number, b: number) => a + b + 1;"), lines: ["export const add = (a: number, b: number) => a + b + 0;"] }],
      }, "patch")),
      replyWith(tool("search", { query: "add", path: "src" }, "search")),
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "cmd")),
      replyWith(tool("finish", { summary: "done" }, "finish")),
    ]);

    const task = codingTask(fixture.runId, fixture.base);
    const result = await new AgentRunner(deps).run(task, handle);

    expect(result.status).toBe("completed");
    expect(provider.calls[0]?.tools?.map((spec) => spec.name)).toEqual([
      "read", "list", "search", "repo_intel", "write", "edit", "run_command", "request_context", "read_output", "request_split", "finish",
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
    // No room for verbatim history, so the earlier searches reach the model through the digest.
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 3, maxTokens: 32_000, contextWindow: 3 });
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

  it("stops a command re-run three times with the same output on an unchanged tree, but not one re-run after an edit", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const argv = ["node", "-e", "console.log('ok')"];
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 6, maxTokens: 64_000 });
    const stalled: { tool: string; repeats: number }[] = [];
    deps.onLoopStalled = (_task, info) => { stalled.push(info); };
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });
    provider.script("worker", Array.from({ length: 6 }, (_, index) => replyWith(tool("run_command", { argv }, `run-${index}`))));
    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    expect(result).toMatchObject({ status: "failed", error: "STALLED" });
    expect(provider.calls).toHaveLength(3);
    expect(stalled).toEqual([{ tool: "run_command", repeats: 3 }]);
    await handle.destroy();

    const editing = harness(store, fixture.policy, { maxTurns: 6, maxTokens: 64_000 });
    const editHandle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });
    editing.provider.script("worker", [
      replyWith(tool("run_command", { argv }, "run-0")),
      replyWith(tool("run_command", { argv }, "run-1")),
      replyWith(tool("write", { path: "notes.txt", content: "edited\n" }, "edit")),
      replyWith(tool("run_command", { argv }, "run-2")),
      replyWith(tool("finish", { summary: "edited and checked" }, "finish")),
    ]);
    expect(await new AgentRunner(editing.deps).run(codingTask(fixture.runId, fixture.base), editHandle)).toMatchObject({ status: "completed" });
    await editHandle.destroy();
    store.close();
  });

  it("stops a command re-run on an unchanged tree even when each run prints its own timings", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const argv = ["node", "-e", "console.log('# duration_ms', process.hrtime.bigint().toString())"];
    const policy = CommandPolicy.forProject([argv], null, false, { search: true });
    const { provider, deps } = harness(store, policy, { maxTurns: 6, maxTokens: 64_000 });
    const stalled: { tool: string; repeats: number }[] = [];
    deps.onLoopStalled = (_task, info) => { stalled.push(info); };
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy });
    provider.script("worker", Array.from({ length: 6 }, (_, index) => replyWith(tool("run_command", { argv }, `run-${index}`))));
    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    const printed = ["run-0", "run-1"].map((callId) =>
      provider.calls[2]?.messages.find((message) => message.role === "tool" && message.toolCallId === callId)?.content);
    expect(printed[0]).toContain("duration_ms");
    expect(printed[1]).toContain("duration_ms");
    expect(printed[0]).not.toBe(printed[1]);
    expect(result).toMatchObject({ status: "failed", error: "STALLED" });
    expect(provider.calls).toHaveLength(3);
    expect(stalled).toEqual([{ tool: "run_command", repeats: 3 }]);
    await handle.destroy();
    store.close();
  });

  it("names the changed paths instead of the diff when the diff would not fit a tool result", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 4, maxTokens: 64_000, contextWindow: 3 });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });
    const bulk = Array.from({ length: 2_000 }, (_, index) => `line-${String(index)}`).join("\n");
    provider.script("worker", [
      replyWith(tool("write", { path: "bulk.txt", content: `${bulk}\n` }, "bulk")),
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "check")),
      replyWith(tool("finish", { summary: "fine", noChange: { reason: "add already sums" } }, "finish")),
    ]);
    await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    const rejection = provider.calls[3]?.messages.at(-1)?.content ?? "";
    expect(rejection).toContain("differs from the base checkpoint in: bulk.txt");
    expect(rejection).not.toContain("line-1999");
    await handle.destroy();
    store.close();
  });

  it("stops a rejected finish sent again and again on an unchanged tree", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 64_000 });
    const stalled: { tool: string; repeats: number }[] = [];
    deps.onLoopStalled = (_task, info) => { stalled.push(info); };
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });
    const noChange = { reason: "add already sums" };
    provider.script("worker", [
      replyWith(tool("write", { path: "notes.txt", content: "scratch\n" }, "scratch")),
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "check")),
      ...Array.from({ length: 6 }, (_, index) => replyWith(tool("finish", { summary: "fine", noChange }, `finish-${index}`))),
    ]);
    const result = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    expect(provider.calls.at(-1)?.messages.at(-1)?.content).toContain("noChange with a non-empty diff");
    expect(result).toMatchObject({ status: "failed", error: "STALLED" });
    expect(provider.calls).toHaveLength(5);
    expect(stalled).toEqual([{ tool: "finish", repeats: 3 }]);
    await handle.destroy();
    store.close();
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
    expect(listed).not.toContain('"outputRef"');
    store.close();
    await handle.destroy();
  });

  it("pages a huge listing and read_output returns the rest without loss", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 200_000 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    mkdirSync(join(handle.path, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(handle.path, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(handle.path, "dist"));
    writeFileSync(join(handle.path, "dist", "bundle.js"), "built\n");
    writeFileSync(join(handle.path, ".gitignore"), "ignored-out/\n");
    mkdirSync(join(handle.path, "ignored-out"));
    writeFileSync(join(handle.path, "ignored-out", "x.txt"), "x\n");
    mkdirSync(join(handle.path, "bulk"));
    for (let i = 0; i < 1_500; i += 1) {
      writeFileSync(join(handle.path, "bulk", `file-${String(i).padStart(4, "0")}.txt`), "x\n");
    }
    const script = [
      replyWith(tool("list", { path: "node_modules", recursive: true }, "list-deps")),
      replyWith(tool("list", { path: ".", recursive: true }, "list")),
    ];
    provider.script("worker", script);
    const pages: { content: string; nextStartLine?: number; outputRef?: string; endLine: number; totalLines: number }[] = [];
    provider.script("worker", Array.from({ length: 6 }, (_, index) => ({
      kind: "fn" as const,
      fn: (request: CompletionRequest) => {
        const last = JSON.parse(request.messages.at(-1)?.content ?? "{}") as { output?: typeof pages[number] };
        if (last.output !== undefined) pages.push(last.output);
        const next = last.output?.nextStartLine;
        const call = next === undefined
          ? tool("finish", { summary: "listed" }, `finish-${String(index)}`)
          : tool("read_output", { ref: pages[0]?.outputRef ?? "", startLine: next }, `more-${String(index)}`);
        return reply("", 1, 1, null, [call]);
      },
    })));

    await new AgentRunner(deps).run({ ...codingTask(fixture.runId, fixture.base), touchesProductCode: false }, handle);

    const skipped = provider.calls[1]?.messages.find((message) => message.role === "tool")?.content ?? "";
    expect(skipped).toContain('"skipped":true');
    const budget = toolResultTokenBudget(undefined);
    for (const call of provider.calls.slice(2)) {
      const message = call.messages.at(-1)?.content ?? "";
      expect(estimateTokens(message)).toBeLessThanOrEqual(budget);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)?.nextStartLine).toBeUndefined();
    const listed = pages.map((page) => page.content).join("\n").split("\n");
    expect(listed).toHaveLength(pages[0]!.totalLines);
    expect(listed.filter((entry) => entry.startsWith("bulk/file-"))).toHaveLength(1_500);
    expect(listed).toContain("dist/bundle.js");
    expect(listed).toContain("src/math.ts");
    expect(listed.some((entry) => entry.includes("node_modules") || entry.includes("ignored-out/x.txt"))).toBe(false);
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

  it("searches the text itself when ripgrep is missing, with ripgrep's exit codes", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 5, maxTokens: 32_000 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    writeFileSync(join(handle.path, "src/calc.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
    writeFileSync(join(handle.path, "src/blob.bin"), Buffer.from("add(\0\x01", "binary"));
    const sandbox = { ...handle, run: () => Promise.reject(new Error("spawn rg ENOENT")) };
    provider.script("worker", [
      replyWith(tool("search", { query: "add\\(", path: "." }, "hit")),
      replyWith(tool("search", { query: "no_such_text_anywhere", path: "src" }, "miss")),
      replyWith(tool("search", { query: "add(", path: "." }, "bad")),
      replyWith(tool("finish", { summary: "searched" }, "finish")),
    ]);
    await new AgentRunner(deps).run({ ...codingTask(fixture.runId, fixture.base), touchesProductCode: false }, sandbox);

    const output = (callIndex: number) =>
      (JSON.parse(provider.calls[callIndex]?.messages.at(-1)?.content ?? "{}") as { output: Record<string, unknown> }).output;
    expect(output(1)).toMatchObject({ exitCode: 0, matchCount: 1, content: "src/calc.mjs:1:export function add(a, b) {", fallback: "text_scan" });
    expect(output(2)).toMatchObject({ exitCode: 1, matchCount: 0 });
    expect(output(3)["exitCode"]).toBe(2);
    expect(output(3)["stderr"]).toMatch(/regex parse error/);
    store.close();
    await handle.destroy();
  });

  it("returns a file whole when it fits and pages it honestly when it does not", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 40, maxTokens: 2_000_000, contextWindow: 32_000 });
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      policy: fixture.policy,
    });
    const small = Array.from({ length: 200 }, (_, i) => `const s${String(i)} = ${String(i)};`);
    const large = Array.from({ length: 3_000 }, (_, i) => `export const line${String(i)} = ${String(i)};`);
    writeFileSync(join(handle.path, "src/small.ts"), `${small.join("\n")}\n`);
    writeFileSync(join(handle.path, "src/long.ts"), `${large.join("\n")}\n`);
    const noise = `${"noise line\n".repeat(1_800)}UNIQUE-MIDDLE-LINE\n${"tail line\n".repeat(400)}`;
    const sandbox = trackingSandbox(handle, () => processResult(noise));
    const results: Record<string, unknown>[] = [];
    let longPages = 0;
    provider.script("worker", [
      replyWith(tool("read", { path: "src/small.ts" }, "small")),
      ...Array.from({ length: 30 }, (_, index) => ({
        kind: "fn" as const,
        fn: (request: CompletionRequest) => {
          const last = JSON.parse(request.messages.at(-1)?.content ?? "{}") as { output?: Record<string, unknown> };
          if (last.output !== undefined) results.push(last.output);
          const output = last.output ?? {};
          let call: ToolCall;
          if (output["path"] === "src/small.ts") {
            call = tool("read", { path: "src/long.ts" }, `long-${String(index)}`);
          } else if (output["path"] === "src/long.ts" && typeof output["nextStartLine"] === "number") {
            longPages += 1;
            call = tool("read", { path: "src/long.ts", startLine: output["nextStartLine"] }, `long-${String(index)}`);
          } else if (output["path"] === "src/long.ts") {
            longPages += 1;
            call = tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "cmd");
          } else if (typeof output["fullOutputRef"] === "string") {
            call = tool("read_output", { ref: output["fullOutputRef"], startLine: 1_790, endLine: 1_810 }, "window");
          } else {
            call = tool("finish", { summary: "read" }, `finish-${String(index)}`);
          }
          return reply("", 1, 1, null, [call]);
        },
      })),
    ]);

    await new AgentRunner(deps).run({ ...codingTask(fixture.runId, fixture.base), touchesProductCode: false }, sandbox);

    const [whole, ...rest] = results;
    expect(whole).toMatchObject({ path: "src/small.ts", startLine: 1, endLine: 200, totalLines: 200 });
    expect(whole?.["nextStartLine"]).toBeUndefined();
    const anchored = (lines: string[]) => lines.map((line, index) => `${anchorOf(index + 1, line)}|${line}`).join("\n");
    expect(whole?.["content"]).toBe(anchored(small));
    const longResults = rest.filter((result) => result["path"] === "src/long.ts");
    expect(longPages).toBe(longResults.length);
    expect(longResults.length).toBeGreaterThan(1);
    expect(longResults.map((result) => result["content"]).join("\n")).toBe(anchored(large));
    for (const [index, result] of longResults.entries()) {
      expect(result["totalLines"]).toBe(3_000);
      if (index > 0) expect(result["startLine"]).toBe(Number(longResults[index - 1]?.["endLine"]) + 1);
    }
    const command = rest.find((result) => Array.isArray(result["argv"]));
    expect(command).toMatchObject({ exitCode: 0, startLine: 1, folded: expect.stringMatching(/^208\d middle lines omitted$/) });
    expect(command?.["content"]).not.toContain("UNIQUE-MIDDLE-LINE");
    expect(command?.["content"]).toContain("tail line");
    const window = rest.find((result) => result["startLine"] === 1_790);
    expect(window).toMatchObject({ endLine: 1_810, nextStartLine: 1_811 });
    expect(window?.["content"]).toContain("UNIQUE-MIDDLE-LINE");
    store.close();
    await handle.destroy();
  });

  it("refuses read_output for a ref this loop did not produce", async () => {
    const fixture = await repositoryFixture();
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(fixture.root);
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 2, maxTokens: 8_000 });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });
    const foreign = store.artifacts.put("secret elsewhere", "agent_output_text", "other run");
    provider.script("worker", [replyWith(tool("read_output", { ref: foreign.sha256 }, "steal"))]);
    await new AgentRunner(deps).run({ ...codingTask(fixture.runId, fixture.base), touchesProductCode: false }, handle);
    const reply = provider.calls[1]?.messages.at(-1)?.content ?? "";
    expect(reply).toContain("no paged output");
    expect(reply).not.toContain("secret elsewhere");
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
      replyWith(tool("edit", { path: "../escaped.txt", edits: [{ op: "replace", start: "1:00", lines: ["still-owned"] }] }, "patch")),
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

  it("accepts noChange only without a diff and after a passing run_command", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 10_000 });
    const noChange = { reason: "add already sums" };
    const unchanged = readFileSync(join(fixture.repoDir, "src/math.ts"), "utf8");
    provider.script("worker", [
      replyWith(tool("write", { path: "src/math.ts", content: unchanged }, "same-bytes")),
      replyWith(tool("finish", { summary: "fine", noChange }, "finish-no-command")),
      replyWith(tool("write", { path: "notes.txt", content: "scratch\n" }, "scratch")),
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "check")),
      replyWith(tool("finish", { summary: "fine", noChange }, "finish-with-diff")),
    ]);
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      branch: "polish/test/no-change-finish",
      policy: fixture.policy,
    });
    const outcome = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    const replies = provider.calls.map((call) => call.messages.at(-1)?.content ?? "");
    expect(replies[2]).toContain("noChange needs an acceptance check run with run_command");
    expect(replies[5]).toContain("noChange with a non-empty diff");
    expect(replies[5]).toContain("call finish again with summary only, without noChange");
    expect(replies[5]).toContain("+++ b/notes.txt");
    expect(replies[5]).toContain("+scratch");
    expect(outcome.status).not.toBe("completed");
    await handle.destroy();

    const clean = await repositoryFixture();
    cleanup.push(clean.root);
    const cleanStore = openStore({ artifactsDir: join(clean.root, "artifacts") });
    const second = harness(cleanStore, clean.policy, { maxTurns: 4, maxTokens: 10_000 });
    second.provider.script("worker", [
      replyWith(tool("run_command", { argv: ["node", "-e", "console.log('ok')"] }, "check")),
      replyWith(tool("finish", { summary: "fine", noChange }, "finish-ok")),
    ]);
    const cleanHandle = await clean.sandbox.create({
      id: id("cand"),
      baseCommit: clean.base,
      branch: "polish/test/no-change-ok",
      policy: clean.policy,
    });
    expect(await new AgentRunner(second.deps).run(codingTask(clean.runId, clean.base), cleanHandle))
      .toMatchObject({ status: "completed", noChange });
    await cleanHandle.destroy();
    store.close();
    cleanStore.close();
  });

  it("request_split ends the loop with parts the council can plan from, and refuses parts it cannot", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 10_000 });
    const parts = [
      { title: "Parser", acceptance: ["parser tests pass"], files: ["src/parse.ts"] },
      { title: "Printer", acceptance: ["printer tests pass"], files: ["src/print.ts"] },
    ];
    provider.script("worker", [
      replyWith(tool("request_split", { reason: "two modules", parts: parts.slice(0, 1) }, "one-part")),
      replyWith(tool("request_split", { reason: "two modules", parts: [parts[0], { title: "Printer", acceptance: [] }] }, "no-acceptance")),
      replyWith(tool("request_split", { reason: " ", parts }, "no-reason")),
      replyWith(tool("request_split", { reason: "two modules", parts }, "ok")),
    ]);
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, branch: "polish/test/split", policy: fixture.policy });
    const outcome = await new AgentRunner(deps).run(codingTask(fixture.runId, fixture.base), handle);
    const replies = provider.calls.map((call) => call.messages.at(-1)?.content ?? "");
    expect(replies[1]).toContain("propose at least two parts");
    expect(replies[2]).toContain("parts[1].acceptance must be a non-empty array");
    expect(replies[3]).toContain("reason must be a non-empty string");
    expect(outcome).toMatchObject({ status: "completed", split: { reason: "two modules", parts } });
    await handle.destroy();

    const investigation = harness(store, fixture.policy, { maxTurns: 2, maxTokens: 10_000 });
    investigation.provider.script("worker", [replyWith(tool("request_split", { reason: "big", parts }, "split"))]);
    const invHandle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, branch: "polish/test/split-inv", policy: fixture.policy });
    const task: Task = { ...codingTask(fixture.runId, fixture.base), kind: "investigation", touchesProductCode: false, origin: { kind: "investigation", findingId: "fnd_1", round: 1 } };
    const refused = await new AgentRunner(investigation.deps).run(task, invHandle);
    expect(refused.status).not.toBe("completed");
    expect(investigation.provider.calls.at(-1)?.messages.at(-1)?.content ?? "").toContain("only a coding task can be split");
    await invHandle.destroy();
    store.close();
  });

  it("an investigation finishes with a reproduction command and may only add files", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 10_000 });
    const argv = ["node", "-e", "console.log('ok')"];
    provider.script("worker", [
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = () => 0;\n" }, "edit-tracked")),
      replyWith(tool("finish", { summary: "reproduced", reproduction: { argv } }, "finish-edited")),
      replyWith(tool("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b;\n" }, "restore")),
      replyWith(tool("write", { path: "repro.test.ts", content: "// reproduction\n" }, "add-file")),
      replyWith(tool("finish", { summary: "reproduced" }, "finish-no-command")),
      replyWith(tool("finish", { summary: "reproduced", reproduction: { argv: ["rm", "-rf", "src"] } }, "finish-denied")),
      replyWith(tool("finish", { summary: "reproduced", reproduction: { argv } }, "finish-ok")),
    ]);
    const handle = await fixture.sandbox.create({
      id: id("cand"),
      baseCommit: fixture.base,
      branch: "polish/test/investigation-finish",
      policy: fixture.policy,
    });
    const task: Task = {
      ...codingTask(fixture.runId, fixture.base),
      kind: "investigation",
      origin: { kind: "investigation", findingId: id("find", NOW), round: 1 },
      touchesProductCode: false,
    };
    const outcome = await new AgentRunner(deps).run(task, handle);

    expect(outcome).toMatchObject({ status: "completed", reproduction: { argv } });
    const rejections = provider.calls.map((call) => call.messages.at(-1)?.content ?? "");
    expect(rejections[2]).toContain("must not modify tracked ones");
    expect(rejections[5]).toContain("must finish with reproduction.argv");
    expect(rejections[6]).toContain("reproduction command is not allowed");
    await handle.destroy();
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

describe("agent tools", () => {
  it("tells the worker that noChange is for a task it did not edit", () => {
    const finish = AGENT_TOOL_DEFINITIONS.find((definition) => definition.name === "finish");
    expect(finish?.description).toContain("before you changed anything");
    expect(finish?.description).toContain("A task you edited finishes without noChange.");
  });

  async function toolsFixture(run?: () => ProcessResult) {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });
    const loopEvidence = createLoopEvidence();
    const tools = createAgentTools({
      sandbox: run === undefined ? handle : trackingSandbox(handle, run),
      commandPolicy: fixture.policy,
      intelligence: new BasicIntel(handle.path),
      artifacts: store.artifacts,
      loopEvidence,
      resultTokens: 10_000,
    });
    return { store, handle, loopEvidence, tools };
  }

  it("edits by anchor, returns fresh anchors, and refuses a no-op edit until it says stop", async () => {
    const { store, handle, loopEvidence, tools } = await toolsFixture();
    const read = await tools.execute("read", { path: "src/math.ts" }) as { content: string };
    const anchor = read.content.split("|")[0] ?? "";
    expect(anchor).toMatch(/^1:[0-9a-f]{2}$/);
    const edited = await tools.execute("edit", {
      path: "src/math.ts",
      edits: [{ op: "replace", start: anchor, lines: ["export const add = (a: number, b: number) => b + a;"] }],
    }) as { lines: string };
    expect(edited.lines).toBe(`${anchorOf(1, "export const add = (a: number, b: number) => b + a;")}|export const add = (a: number, b: number) => b + a;`);
    expect(loopEvidence.patches).toEqual(["src/math.ts"]);
    const same = { path: "src/math.ts", edits: [{ op: "replace", start: edited.lines.split("|")[0], lines: ["export const add = (a: number, b: number) => b + a;"] }] };
    await expect(tools.execute("edit", same)).rejects.toThrow(/produced no change/);
    await expect(tools.execute("edit", same)).rejects.toThrow(/produced no change/);
    await expect(tools.execute("edit", same)).rejects.toThrow(/^STOP\./);
    await expect(tools.execute("edit", { path: "src/math.ts", edits: [{ op: "replace", start: anchor, lines: ["x"] }] }))
      .rejects.toThrow(/changed since it was read/);
    expect(loopEvidence.patches).toEqual(["src/math.ts"]);
    store.close();
    await handle.destroy();
  });

  it("lists a subdirectory's direct children, or every nested path below it without the directory itself", async () => {
    const { store, handle, tools } = await toolsFixture();
    mkdirSync(join(handle.path, "src", "a", "b"), { recursive: true });
    writeFileSync(join(handle.path, "src", "a", "b", "c.ts"), "export {};\n");
    writeFileSync(join(handle.path, "src", "a", "d.ts"), "export {};\n");
    const flat = await tools.execute("list", { path: "src" }) as { content: string };
    expect(flat.content.split("\n")).toEqual(["src/a/", "src/math.ts"]);
    const nested = await tools.execute("list", { path: "src", recursive: true }) as { content: string };
    expect(nested.content.split("\n")).toEqual(["src/a/", "src/a/b/", "src/a/b/c.ts", "src/a/d.ts", "src/math.ts"]);
    store.close();
    await handle.destroy();
  });

  it("counts only a command that exited 0 without timing out as a passed check", async () => {
    const results = [
      { ...processResult("fail"), exitCode: 1 },
      { ...processResult("slow"), timedOut: true },
      processResult("ok"),
    ];
    const { store, handle, loopEvidence, tools } = await toolsFixture(() => results.shift() ?? processResult("ok"));
    const argv = ["node", "-e", "console.log('ok')"];
    await tools.execute("run_command", { argv });
    await tools.execute("run_command", { argv });
    expect(loopEvidence.passedCommands).toEqual([]);
    await tools.execute("run_command", { argv });
    expect(loopEvidence.passedCommands).toEqual([argv]);
    expect(loopEvidence.commandOutputRefs).toHaveLength(3);
    store.close();
    await handle.destroy();
  });

  it("keeps the final newline a rewritten file already had, and only then", async () => {
    const { store, handle, tools } = await toolsFixture();
    writeFileSync(join(handle.path, "src/lf.mjs"), "export const a = 1;\n");
    writeFileSync(join(handle.path, "src/crlf.mjs"), "export const a = 1;\r\n");
    writeFileSync(join(handle.path, "src/bare.mjs"), "export const a = 1;");
    expect(await tools.execute("write", { path: "src/lf.mjs", content: "export const a = 1;" }))
      .toMatchObject({ bytes: 20, finalNewlineKept: true });
    await tools.execute("write", { path: "src/crlf.mjs", content: "export const a = 1;" });
    await tools.execute("write", { path: "src/bare.mjs", content: "export const a = 2;" });
    await tools.execute("write", { path: "src/new.mjs", content: "export const b = 1;" });
    writeFileSync(join(handle.path, "src/emptied.mjs"), "export const a = 1;\n");
    await tools.execute("write", { path: "src/emptied.mjs", content: "" });
    expect(readFileSync(join(handle.path, "src/emptied.mjs"), "utf8")).toBe("");
    expect(readFileSync(join(handle.path, "src/lf.mjs"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(handle.path, "src/crlf.mjs"), "utf8")).toBe("export const a = 1;\r\n");
    expect(readFileSync(join(handle.path, "src/bare.mjs"), "utf8")).toBe("export const a = 2;");
    expect(readFileSync(join(handle.path, "src/new.mjs"), "utf8")).toBe("export const b = 1;");
    store.close();
    await handle.destroy();
  });
});

describe("pageLines", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${String(i + 1)}`);

  it("never drops a line without saying where to continue", () => {
    expect(pageLines(lines, 1, undefined, 1_000)).toMatchObject({ startLine: 1, endLine: 10, totalLines: 10 });
    expect(pageLines(lines, 1, undefined, 1_000).nextStartLine).toBeUndefined();
    const first = pageLines(lines, 1, undefined, 5);
    expect(first).toMatchObject({ startLine: 1, endLine: 2, nextStartLine: 3 });
    expect(pageLines(lines, 3, 4, 1_000)).toMatchObject({ startLine: 3, endLine: 4, nextStartLine: 5, content: "line 3\nline 4" });
    expect(pageLines([], 1, undefined, 10)).toMatchObject({ endLine: 0, totalLines: 0, content: "" });
    expect(() => pageLines(lines, 11, undefined, 10)).toThrow(/past the end/);
    expect(() => pageLines(lines, 5, 3, 10)).toThrow(/before startLine/);
  });

  it("cuts a single line longer than a page and reports how much is shown", () => {
    const page = pageLines(["x".repeat(100), "y"], 1, undefined, 10);
    expect(page).toMatchObject({ startLine: 1, endLine: 1, nextStartLine: 2, partialLine: { line: 1, shownChars: 20, totalChars: 100 } });
    expect(page.content).toBe("x".repeat(20));
  });
});
