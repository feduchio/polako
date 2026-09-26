import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage, CompletionRequest, ToolCall } from "../broker/types.js";
import { estimateTokens } from "../context/types.js";
import { defaultConfig } from "../domain/config.js";
import type { Task } from "../domain/task.js";
import { BasicIntel } from "../intel/basic.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { AgentRunner } from "./runner.js";
import type { AgentRunnerDeps, AgentTranscript } from "./types.js";

const NOW = 1_700_000_000_000;
const FAILING = ["node", "fail-late.js"];
const FAILING_EARLIER = ["node", "fail-early.js"];
/** Deliberately absent from the argv: an assertion that matched the argv would pass with no tail. */
const LATE_MARKER = "zeta-teardown-exploded";
const EARLIER_MARKER = "alpha-setup-exploded";
/** Sits at the start of an output longer than the bound, so only a tail rendering drops it. */
const LATE_HEAD_MARKER = "omega-head-of-the-failure";
const cleanup: string[] = [];
/**
 * A context with no room for verbatim history, so every turn but the newest reaches the model
 * through the digest: most checks here are about the digest, and a realistic window would send the
 * turns they inspect word for word instead.
 */
const DIGEST_ONLY_CONTEXT = 3;
const LONG_DIR = "deeply/nested/directory/of/the/project";
/** Long enough that twenty of them want more than a 200-token digest and less than a 400 one. */
const LONG_PATHS = Array.from(
  { length: 20 },
  (_, i) => `${LONG_DIR}/module-with-a-descriptive-name-${String(i).padStart(2, "0")}.ts`,
);

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("the worker's context window", () => {
  it("stops growing with the turn index, and keeps the whole loop in the archive", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 24, maxTokens: 32_000 });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });

    // Twenty reads of ~2,000 characters each, with one mid-loop turn asking for two at once.
    provider.script("worker", [
      reply([call("read", { path: "big-0.txt" })]),
      reply([call("read", { path: "big-1.txt" })]),
      reply([call("read", { path: "big-2.txt" }), call("read", { path: "big-3.txt" })]),
      ...Array.from({ length: 16 }, (_, i) => reply([call("read", { path: `big-${String(i + 4)}.txt` })])),
      reply([call("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" })]),
      reply([call("finish", { summary: "done" })]),
    ]);

    const task = codingTask(fixture.runId, fixture.base);
    const result = await new AgentRunner(deps).runLoop(task, handle);
    expect(result.status).toBe("FINISHED");
    expect(provider.calls.length).toBeGreaterThanOrEqual(20);

    // AC1. Measured over the message bodies actually sent. `ScriptedProvider` reports a fixed
    // usage of 10 input tokens, so a check reading `usage.inputTokens` would be green either way.
    const sizes = provider.calls.map(requestTokens);
    expect(sizes[19]! - sizes[4]!).toBeLessThanOrEqual(400);

    // MC1 bounds the *historical* footprint, which is everything the request carries besides the
    // most recent turn. Total size is not bounded and must not be asserted to be: the turn that
    // asked for two reads at once makes the next request legitimately larger, and MC5 requires
    // exactly that. Measured across the whole loop the footprint is the pack plus at most one
    // digest, where on the unmodified tree it grows with every turn.
    // No system prompt is configured here, so turn one's request is the pack and nothing else.
    // The builder observes the same clause, but only the loop can show what the runner sends.
    expect(provider.calls[0]!.messages).toHaveLength(1);
    expect(provider.calls[0]!.messages[0]).toEqual({ role: "user", content: task.description });

    // The pack is the one part of the prompt that must be on every request, and asserting it only
    // on turn one leaves the rest of the loop to a builder-level check.
    for (const request of provider.calls) {
      expect(request.messages[0]).toEqual({ role: "user", content: task.description });
    }

    const footprints = provider.calls.map(historicalTokens);
    const pack = footprints[0]!;
    expect(Math.max(...footprints)).toBeLessThanOrEqual(pack + 400);
    expect(footprints.at(-1)!).toBeLessThanOrEqual(footprints[4]! + 400);

    // AC3. Every request, including the one carrying the two-call turn.
    for (const request of provider.calls) expectPairing(request.messages);
    const twoCall = provider.calls.find((request) =>
      (request.messages.at(-3) as Extract<ChatMessage, { role: "assistant" }> | undefined)?.toolCalls?.length === 2,
    );
    expect(twoCall).toBeDefined();
    expect(twoCall!.messages.filter((message) => message.role === "tool")).toHaveLength(2);

    // AC2. The archive keeps every message, including the first turn's output, which by the end
    // is no longer on the wire.
    const transcript = JSON.parse(store.artifacts.getText(result.transcriptRef.sha256)) as AgentTranscript;
    const toolMessages = transcript.turns.reduce((sum, t) => sum + t.toolResults.length, 0);
    expect(transcript.messages).toHaveLength(1 + transcript.turns.length + toolMessages);
    expect(transcript.messages.map((m) => m.content).join("\n")).toContain("marker-big-0");
    expect(bodyOf(provider.calls.at(-1)!)).not.toContain("marker-big-0");

    // A count and one sampled body leave the other two thirds of MC2 unwatched: a reversed
    // archive, or one message's content replaced, satisfies both. Walk it positionally instead.
    expect(transcript.messages[0]).toEqual({ role: "user", content: task.description });
    let at = 1;
    for (const t of transcript.turns) {
      const assistant = transcript.messages[at];
      expect(assistant?.role).toBe("assistant");
      expect(assistant?.content).toBe(t.assistant.content);
      expect((assistant as Extract<ChatMessage, { role: "assistant" }>).toolCalls?.map((c) => c.id))
        .toEqual(t.assistant.toolCalls?.map((c) => c.id));
      at += 1;
      for (const outcome of t.toolResults) {
        const message = transcript.messages[at];
        expect(message?.role).toBe("tool");
        expect((message as Extract<ChatMessage, { role: "tool" }>).toolCallId).toBe(outcome.toolCallId);
        expect(message?.content).toBe(
          outcome.name === "finish"
            ? JSON.stringify({ ok: true, accepted: true })
            : JSON.stringify({ ok: true, output: outcome.output }),
        );
        at += 1;
      }
    }
    expect(at).toBe(transcript.messages.length);

    store.close();
    await handle.destroy();
  });

  it("sends the most recent turn's output in full, however large", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    // A realistic context, so the read is one page and not paged: the check is about the window.
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 6, maxTokens: 32_000, contextWindow: 32_000 });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });

    provider.script("worker", [
      reply([call("read", { path: "wide.txt" })]),
      reply([call("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" })]),
      reply([call("finish", { summary: "done" })]),
    ]);

    const result = await new AgentRunner(deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("FINISHED");
    // AC5. Eviction is for history; the turn the worker is reasoning about arrives untouched.
    expect(bodyOf(provider.calls[1]!)).toContain(fixture.wide);

    store.close();
    await handle.destroy();
  });

  it("inventories every tool the worker used, and why the last command failed", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 13, maxTokens: 32_000 });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });

    provider.script("worker", [
      reply([call("read", { path: "docs/read-only-here.md" })]),
      reply([call("list", { path: "src" })]),
      reply([call("search", { query: "add", path: "src" })]),
      reply([call("repo_intel", { action: "symbol", query: "add" })]),
      reply([call("write", { path: "src/created.ts", content: "export const one = 1;\n" })]),
      reply([call("apply_patch", { path: "src/math.ts", oldText: "a + b", newText: "a + b + 0" })]),
      reply([call("run_command", { argv: FAILING_EARLIER })]),
      reply([call("run_command", { argv: FAILING })]),
      reply([call("request_context", { query: "why is add wrong" })]),
      reply([call("read", { path: "big-0.txt" })]),
      reply([call("finish", { summary: "done" })]),
    ]);

    const result = await new AgentRunner(deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("FINISHED");

    // AC6. The digest of the request after all eight non-terminal tools have run.
    const digest = digestOf(provider.calls[10]!);
    expect(digest).toBeDefined();
    for (const expected of [
      "read docs/read-only-here.md",
      "list src",
      'search "add"',
      'symbol "add"',
      "src/created.ts (write)",
      "src/math.ts (patch)",
      'request_context "why is add wrong"',
      "exit 3",
      LATE_MARKER,
      "fail-late.js",
    ]) {
      expect(digest!).toContain(expected);
    }
    // Only the newest failure keeps its output, so a run of failures cannot crowd out the rest.
    expect(digest!).toContain("fail-early.js -> exit 4");
    expect(digest!).not.toContain(EARLIER_MARKER);
    // The output outran the bound, so its head is gone and its end is what the worker sees.
    expect(digest!).not.toContain(LATE_HEAD_MARKER);

    store.close();
    await handle.destroy();
  });

  it("carries turn one's reasoning into turn three's request and not into turn fifteen's", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 20, maxTokens: 32_000 });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });

    // AC9 is worded about requests, so it is checked on requests. The prose must be long enough
    // that fourteen turns of it overflow the cap, or the absence at turn fifteen proves nothing.
    const prose = (n: number): string =>
      n === 1 ? `DISTINCTIVE-ALPHA-MARKER ${"reasoning ".repeat(19)}` : `step ${String(n)} ${"reasoning ".repeat(19)}`;
    provider.script("worker", [
      ...Array.from({ length: 14 }, (_, i) => ({
        kind: "reply" as const,
        content: prose(i + 1),
        toolCalls: [call("read", { path: `big-${String(i)}.txt` })],
      })),
      reply([call("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" })]),
      reply([call("finish", { summary: "done" })]),
    ]);

    const result = await new AgentRunner(deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("FINISHED");

    expect(digestOf(provider.calls[2]!)).toContain("DISTINCTIVE-ALPHA-MARKER");
    const fifteenth = digestOf(provider.calls[14]!);
    expect(fifteenth).toBeDefined();
    expect(fifteenth!).not.toContain("DISTINCTIVE-ALPHA-MARKER");
    expect(fifteenth!).toContain("step 13");

    store.close();
    await handle.destroy();
  });

  it("gives the production seam the budget-derived allowance, not a smaller one", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    // 32_000 is the production effective task budget, for which the contract derives 400. A seam
    // wired to some other quantity - maxTurns, say - yields 200 and is otherwise silent.
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 24, maxTokens: 32_000 });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });

    provider.script("worker", [
      ...LONG_PATHS.map((path) => reply([call("read", { path })])),
      reply([call("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" })]),
      reply([call("finish", { summary: "done" })]),
    ]);

    const result = await new AgentRunner(deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("FINISHED");

    const digest = digestOf(provider.calls.at(-1)!);
    expect(digest).toBeDefined();
    const size = estimateTokens(digest!);
    expect(size).toBeGreaterThan(200);
    expect(size).toBeLessThanOrEqual(400);

    store.close();
    await handle.destroy();
  });

  it("puts a configured system prompt on the first request and every one after it", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    // Production composition does not set a system prompt today, so nothing else in the suite
    // exercises this branch through a real loop; the builder test alone leaves the runner's own
    // insertion unobserved.
    const system = "the standing system message";
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 6, maxTokens: 32_000, systemPrompt: system });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });

    provider.script("worker", [
      reply([call("read", { path: "big-0.txt" })]),
      reply([call("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" })]),
      reply([call("finish", { summary: "done" })]),
    ]);

    const result = await new AgentRunner(deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("FINISHED");

    expect(provider.calls[0]!.messages).toHaveLength(2);
    expect(provider.calls[0]!.messages[0]).toEqual({ role: "system", content: system });
    for (const request of provider.calls) {
      expect(request.messages[0]).toEqual({ role: "system", content: system });
    }

    store.close();
    await handle.destroy();
  });

  it("keeps both files on the wire when a worker reads one and then the other", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const { provider, deps } = harness(store, fixture.policy, { maxTurns: 6, maxTokens: 64_000, contextWindow: 128_000 });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });

    provider.script("worker", [
      reply([call("read", { path: "big-0.txt" })]),
      reply([call("read", { path: "big-1.txt" })]),
      reply([call("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" })]),
      reply([call("finish", { summary: "done" })]),
    ]);

    const result = await new AgentRunner(deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(result.status).toBe("FINISHED");
    const third = bodyOf(provider.calls[2]!);
    expect(third).toContain("marker-big-0");
    expect(third).toContain("marker-big-1");
    expect(digestOf(provider.calls[2]!)).toBeUndefined();
    for (const request of provider.calls) expectPairing(request.messages);

    store.close();
    await handle.destroy();
  });

  it("keeps the budget and turn stopping conditions it had before", async () => {
    const fixture = await repositoryFixture();
    cleanup.push(fixture.root);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const handle = await fixture.sandbox.create({ id: id("cand"), baseCommit: fixture.base, policy: fixture.policy });

    const tokens = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 20 });
    tokens.provider.script("worker", [
      reply([call("read", { path: "big-0.txt" })]),
      reply([call("read", { path: "big-1.txt" })]),
    ]);
    const budget = await new AgentRunner(tokens.deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(budget.status).toBe("BUDGET_EXCEEDED");

    const turns = harness(store, fixture.policy, { maxTurns: 2, maxTokens: 32_000 });
    turns.provider.script("worker", [
      reply([call("read", { path: "big-0.txt" })]),
      reply([call("read", { path: "big-1.txt" })]),
      reply([call("finish", { summary: "never reached" })]),
    ]);
    const capped = await new AgentRunner(turns.deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(capped.status).toBe("BUDGET_EXCEEDED");
    expect(capped.turns).toBe(2);

    // The outcomes above survive an accounting that drops either term, because exhaustion still
    // happens eventually. The sum itself has to be asserted: 10 in and 5 out per scripted call.
    const counted = harness(store, fixture.policy, { maxTurns: 8, maxTokens: 32_000 });
    counted.provider.script("worker", [
      reply([call("read", { path: "big-0.txt" })]),
      reply([call("write", { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b + 1;\n" })]),
      reply([call("finish", { summary: "done" })]),
    ]);
    const finished = await new AgentRunner(counted.deps).runLoop(codingTask(fixture.runId, fixture.base), handle);
    expect(finished.status).toBe("FINISHED");
    expect(finished.turns).toBe(3);
    expect(finished.totalTokens).toBe(3 * (10 + 5));

    store.close();
    await handle.destroy();
  });
});

/**
 * Every tool message belongs to a contiguous run following the assistant that asked for it, and
 * the run answers all of that assistant's calls. Completeness matters: a window keeping only the
 * first result of a multi-call turn is a provider rejection, not a smaller prompt.
 */
function expectPairing(messages: readonly ChatMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role !== "tool") continue;
    let start = i;
    while (start > 0 && messages[start - 1]?.role === "tool") start -= 1;
    const owner = messages[start - 1];
    expect(owner?.role).toBe("assistant");
    const answered: string[] = [];
    for (let j = start; j < messages.length && messages[j]?.role === "tool"; j += 1) {
      answered.push((messages[j] as Extract<ChatMessage, { role: "tool" }>).toolCallId);
    }
    expect(answered).toEqual((owner as Extract<ChatMessage, { role: "assistant" }>).toolCalls?.map((c) => c.id));
    i = start + answered.length - 1;
  }
}

function bodyOf(request: CompletionRequest): string {
  return request.messages.map((message) => message.content).join("\n");
}

function requestTokens(request: CompletionRequest): number {
  return estimateTokens(bodyOf(request));
}

/** Everything the request carries except the most recent turn. */
function historicalTokens(request: CompletionRequest): number {
  const messages = request.messages;
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const history = lastAssistant === -1 ? messages : messages.slice(0, lastAssistant);
  return estimateTokens(history.map((message) => message.content).join("\n"));
}

function digestOf(request: CompletionRequest): string | undefined {
  return request.messages.find((message) => message.content.startsWith("## Earlier in this loop"))?.content;
}

let nextCall = 0;

function call(name: string, args: unknown): ToolCall {
  return { id: `tc-${String(nextCall += 1)}`, name, arguments: JSON.stringify(args) };
}

function reply(toolCalls: ToolCall[]) {
  return { kind: "reply" as const, content: "", toolCalls };
}

function harness(
  store: Store,
  policy: CommandPolicy,
  overrides: Partial<AgentRunnerDeps>,
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
      maxTokens: 32_000,
      contextWindow: DIGEST_ONLY_CONTEXT,
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

async function repositoryFixture(): Promise<{
  root: string;
  base: string;
  runId: string;
  wide: string;
  sandbox: WorktreeSandbox;
  policy: CommandPolicy;
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-window-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  const git = await Git.init(repoDir);
  mkdirSync(join(repoDir, "src"));
  writeFileSync(join(repoDir, "src/math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  for (let i = 0; i < 20; i += 1) {
    writeFileSync(join(repoDir, `big-${String(i)}.txt`), `marker-big-${String(i)} ${"q".repeat(1_980)}\n`);
  }
  mkdirSync(join(repoDir, "docs"));
  writeFileSync(join(repoDir, "docs/read-only-here.md"), "a path no other tool in that loop names\n");
  mkdirSync(join(repoDir, LONG_DIR), { recursive: true });
  for (const path of LONG_PATHS) writeFileSync(join(repoDir, path), "short\n");
  writeFileSync(
    join(repoDir, "fail-late.js"),
    `process.stderr.write(${JSON.stringify(`${LATE_HEAD_MARKER} ${"detail ".repeat(60)} ${LATE_MARKER}`)});process.exit(3);\n`,
  );
  writeFileSync(
    join(repoDir, "fail-early.js"),
    `process.stderr.write(${JSON.stringify(`${EARLIER_MARKER}: the setup hook threw`)});process.exit(4);\n`,
  );
  const wide = `wide-marker ${"w".repeat(3_990)}`;
  writeFileSync(join(repoDir, "wide.txt"), `${wide}\n`);
  const base = await git.commitAll("base");
  if (base === null) throw new Error("fixture base commit missing");
  return {
    root,
    base,
    runId: id("run"),
    wide,
    sandbox: new WorktreeSandbox(repoDir, join(root, "worktrees"), defaultConfig().sandbox),
    policy: CommandPolicy.forProject([FAILING, FAILING_EARLIER], null, false, { search: true }),
  };
}
