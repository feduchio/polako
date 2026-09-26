import type { ModelRef } from "../domain/common.js";
import type { ChatMessage } from "../broker/types.js";
import { isBudgetError } from "../broker/quota.js";
import { estimateTokens } from "../context/types.js";
import { BasicIntel } from "../intel/basic.js";
import type { Task } from "../domain/task.js";
import { PolishError, errorToString } from "../shared/errors.js";
import { buildWireWindow, loopDigestCap } from "./loopWindow.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import {
  type AgentTools,
  createAgentTools,
  createLoopEvidence,
  hasLoopEvidence,
  loopEvidenceRefs,
} from "./tools.js";
import type {
  AgentLoopResult,
  AgentProgressRecord,
  AgentProgressState,
  AgentRunnerDeps,
  AgentRunStatus,
  AgentToolResult,
  AgentTranscript,
  AgentTurn,
  CandidateWorker,
  LoopEvidence,
  WorkerOutcome,
  WorkerNoChange,
  WorkerReproduction,
  WorkerSplitRequest,
} from "./types.js";

interface FinishArgs {
  summary: string;
  reproduction?: WorkerReproduction;
  noChange?: WorkerNoChange;
  split?: WorkerSplitRequest;
}

/**
 * "Nothing to change" is a claim like any other. The worker has to have watched a check pass on
 * the code as it stands, and must not have changed that code; the engine still re-runs the gates.
 */
function validateNoChange(value: unknown, diff: string, loopEvidence: LoopEvidence, diffTokens: number): WorkerNoChange {
  const reason = record(value, "finish noChange")["reason"];
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new PolishError("INVALID_ARGUMENT", "finish rejected: noChange.reason must be a non-empty string");
  }
  if (diff.trim() !== "") {
    throw new PolishError(
      "INVALID_ARGUMENT",
      "finish rejected: noChange with a non-empty diff; revert the edits or finish without noChange. " + describeDiff(diff, diffTokens),
    );
  }
  if (loopEvidence.passedCommands.length === 0) {
    throw new PolishError(
      "INVALID_ARGUMENT",
      "finish rejected: noChange needs an acceptance check run with run_command in this loop that exited 0",
    );
  }
  return { reason };
}

/**
 * The worker cannot see the base, so "revert" alone does not tell it what to put back. In
 * run_01m3drb07720355x3z1s63 a worker had rewritten a file without its final newline, "reverted" it
 * twice to the same bytes, and finished with a one-byte change instead of noChange.
 */
function describeDiff(diff: string, diffTokens: number): string {
  if (estimateTokens(diff) <= diffTokens) return `The worktree differs from the base checkpoint by:\n${diff}`;
  const paths = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]);
  return `The worktree differs from the base checkpoint in: ${paths.join(", ")}`;
}

/** Parts the council can plan from: two or more, each with a title and something to check. */
function validateSplit(value: unknown, task: Task): WorkerSplitRequest {
  if (task.kind === "investigation" || !task.touchesProductCode) {
    throw new PolishError("INVALID_ARGUMENT", "request_split rejected: only a coding task can be split");
  }
  const args = record(value, "request_split arguments");
  const reason = args["reason"];
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new PolishError("INVALID_ARGUMENT", "request_split rejected: reason must be a non-empty string");
  }
  const rawParts = args["parts"];
  if (!Array.isArray(rawParts) || rawParts.length < 2) {
    throw new PolishError("INVALID_ARGUMENT", "request_split rejected: propose at least two parts");
  }
  const parts = rawParts.map((raw, index) => {
    const part = record(raw, `request_split parts[${String(index)}]`);
    const title = part["title"];
    const acceptance = part["acceptance"];
    const files: unknown = part["files"] ?? [];
    if (typeof title !== "string" || title.trim() === "") {
      throw new PolishError("INVALID_ARGUMENT", `request_split rejected: parts[${String(index)}].title must be a non-empty string`);
    }
    if (!Array.isArray(acceptance) || acceptance.length === 0 || !acceptance.every((item) => typeof item === "string" && item.trim() !== "")) {
      throw new PolishError("INVALID_ARGUMENT", `request_split rejected: parts[${String(index)}].acceptance must be a non-empty array of non-empty strings`);
    }
    if (!Array.isArray(files) || !files.every((item) => typeof item === "string")) {
      throw new PolishError("INVALID_ARGUMENT", `request_split rejected: parts[${String(index)}].files must be an array of strings`);
    }
    return { title, acceptance: acceptance as string[], files };
  });
  return { reason, parts };
}
import { progressStateFingerprint, shouldAbandonProgress } from "./progressTracker.js";
import { sha256Hex } from "../shared/hash.js";

export class AgentRunner implements CandidateWorker {
  get model(): ModelRef {
    return this.deps.model;
  }

  private readonly redact: (text: string) => string;
  private readonly now: () => number;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.redact = deps.redact ?? ((text) => text);
    this.now = deps.now ?? Date.now;
  }

  run(task: Task, worktree: SandboxHandle): Promise<WorkerOutcome> {
    return this.runLoop(task, worktree).then((result) => toWorkerOutcome(result));
  }

  async runLoop(task: Task, worktree: SandboxHandle): Promise<AgentLoopResult> {
    validateBudgets(this.deps);
    const startedAt = this.now();
    const loopEvidence = createLoopEvidence();
    const intelligence = (this.deps.createIntelligence ?? ((path) => new BasicIntel(path)))(worktree.path);
    await intelligence.prepare();

    // One array, two jobs, and they are no longer the same array's problem: `messages` is the
    // archive and may never shrink, while each request carries a window built from it.
    const messages: ChatMessage[] = [];
    const digestCap = loopDigestCap(this.deps.maxTokens);
    if (this.deps.systemPrompt !== undefined) messages.push({ role: "system", content: this.deps.systemPrompt });
    const composed = this.deps.prompt?.(task) ?? null;
    messages.push({ role: "user", content: composed?.text ?? task.description });

    const turns: AgentTurn[] = [];
    const tools = createAgentTools({
      sandbox: worktree,
      commandPolicy: this.deps.commandPolicy,
      intelligence,
      artifacts: this.deps.artifacts,
      loopEvidence,
      ...(this.deps.requestContext === undefined ? {} : { requestContext: this.deps.requestContext }),
      redact: this.redact,
      resultTokens: toolResultTokenBudget(this.deps.contextWindow),
    });

    let totalTokens = 0;
    let status: AgentRunStatus = "STOPPED";
    let output: string | null = null;
    let reproduction: WorkerReproduction | null = null;
    let noChange: WorkerNoChange | null = null;
    let split: WorkerSplitRequest | null = null;
    let acceptedEvidence: LoopEvidence | null = null;
    const repeats = new Map<string, { count: number; diffHash: string }>();
    const progressTracker = this.deps.createProgressTracker?.(task) ?? null;
    const progress: AgentProgressRecord[] = [];
    const progressStates = new Map<number, AgentProgressState>();

    while (turns.length < this.deps.maxTurns && totalTokens < this.deps.maxTokens) {
      const remainingTokens = this.deps.maxTokens - totalTokens;
      let call;
      try {
        call = await this.deps.complete({
          model: this.deps.model,
          messages: buildWireWindow({ archive: messages, turns, digestCap, verbatimTokens: historyTokenBudget(this.deps.contextWindow) }),
          tools: tools.definitions,
          maxTokens: remainingTokens,
          metadata: {
            runId: task.runId,
            purpose: "agent_run",
            role: "worker",
            taskId: task.id,
            taskAttempt: task.attempts,
          },
          ...(this.deps.signal === undefined ? {} : { signal: this.deps.signal }),
        });
      } catch (error) {
        if (!isBudgetError(error)) throw error;
        status = "BUDGET_EXCEEDED";
        break;
      }

      const assistant = call.message;
      messages.push(assistant);
      totalTokens += call.usage.inputTokens + call.usage.outputTokens;
      const turn: AgentTurn = {
        turn: turns.length + 1,
        assistant,
        usage: call.usage,
        toolResults: [],
      };
      turns.push(turn);

      if (totalTokens > this.deps.maxTokens) {
        status = "BUDGET_EXCEEDED";
        break;
      }

      const calls = assistant.toolCalls ?? [];
      if (calls.length === 0) {
        status = "STOPPED";
        break;
      }

      for (const toolCall of calls) {
        const result = await this.executeTool(
          tools,
          toolCall.id,
          toolCall.name,
          toolCall.arguments,
          task,
          worktree,
          loopEvidence,
          this.deps.signal,
        );
        turn.toolResults.push(result.event);
        messages.push({ role: "tool", toolCallId: toolCall.id, content: result.message });
        if (result.finish !== null) {
          acceptedEvidence = loopEvidence;
          output = result.finish.summary;
          reproduction = result.finish.reproduction ?? null;
          noChange = result.finish.noChange ?? null;
          split = result.finish.split ?? null;
          status = "FINISHED";
          break;
        }
        const stalled = await this.repeatedWithoutProgress(
          toolCall.name,
          toolCall.arguments,
          result.message,
          worktree,
          repeats,
        );
        if (stalled !== null) {
          status = "STALLED";
          this.deps.onLoopStalled?.(task, stalled);
          break;
        }
      }
      if (status === "FINISHED" || status === "STALLED") break;
      if (progressTracker !== null && (turn.turn === 4 || turn.turn === 8 || turn.turn === 12)) {
        const state = await this.progressState(task, worktree, loopEvidence);
        if (state !== null) {
          progressStates.set(turn.turn, state);
          const previousTurn = turn.turn === 8 ? 4 : turn.turn === 12 ? 8 : null;
          const previous = previousTurn === null ? null : progressStates.get(previousTurn) ?? null;
          if (
            turn.turn !== 4 &&
            previous !== null &&
            progressStateFingerprint(previous) === progressStateFingerprint(state)
          ) {
            const score = await progressTracker.score({ task, turns, state });
            if (score !== null) {
              const abandon = shouldAbandonProgress(score.modelScores);
              const record: AgentProgressRecord = {
                turn: turn.turn,
                ...score,
                decision: abandon ? "abandon" : "continue",
              };
              progress.push(record);
              this.deps.onProgress?.(task, record);
              if (abandon) {
                status = "ABANDONED_PROGRESS";
                break;
              }
            }
          }
        }
      }
      if (turns.length >= this.deps.maxTurns || totalTokens >= this.deps.maxTokens) {
        status = "BUDGET_EXCEEDED";
        break;
      }
    }

    if (
      status !== "FINISHED" &&
      status !== "ABANDONED_PROGRESS" &&
      status !== "STALLED" &&
      (turns.length >= this.deps.maxTurns || totalTokens >= this.deps.maxTokens)
    ) {
      status = "BUDGET_EXCEEDED";
    }

    return this.persistResult({
      task,
      messages,
      turns,
      totalTokens,
      status,
      loopEvidence: acceptedEvidence,
      output,
      reproduction,
      noChange,
      split,
      startedAt,
      progress,
      protocolHash: composed?.protocolHash ?? null,
    });
  }

  private async executeTool(
    tools: AgentTools,
    toolCallId: string,
    name: string,
    encodedArgs: string,
    task: Task,
    worktree: SandboxHandle,
    loopEvidence: LoopEvidence,
    signal: AbortSignal | undefined,
  ): Promise<{
    event: AgentToolResult;
    message: string;
    finish: FinishArgs | null;
  }> {
    try {
      const args: unknown = JSON.parse(encodedArgs);
      if (name === "request_split") {
        const split = validateSplit(args, task);
        return {
          event: { toolCallId, name, ok: true, output: { accepted: true } },
          message: this.redact(JSON.stringify({ ok: true, accepted: true })),
          finish: { summary: split.reason, split },
        };
      }
      if (name === "finish") {
        const finish = await this.validateFinish(args, task, worktree, loopEvidence);
        const message = this.redact(JSON.stringify({ ok: true, accepted: true }));
        return {
          event: { toolCallId, name, ok: true, output: { accepted: true } },
          message,
          finish,
        };
      }
      const output = await tools.execute(name, args, signal);
      const scrubbed = scrubUnknown(output, this.redact);
      const bounded = boundToolResult(scrubbed, toolResultTokenBudget(this.deps.contextWindow), (text, label) => tools.page(text, label), name);
      return {
        event: { toolCallId, name, ok: true, output: bounded.output },
        message: bounded.message,
        finish: null,
      };
    } catch (error) {
      const message = this.redact(errorToString(error));
      return {
        event: { toolCallId, name, ok: false, error: message },
        message: JSON.stringify({ ok: false, error: message }),
        finish: null,
      };
    }
  }

  private async validateFinish(
    value: unknown,
    task: Task,
    worktree: SandboxHandle,
    loopEvidence: LoopEvidence,
  ): Promise<FinishArgs> {
    const args = record(value, "finish arguments");
    const summary = args["summary"];
    if (typeof summary !== "string" || summary.trim() === "") {
      throw new PolishError("INVALID_ARGUMENT", "finish summary must be a non-empty string");
    }
    if (!hasLoopEvidence(loopEvidence)) {
      throw new PolishError(
        "INVALID_ARGUMENT",
        "finish rejected: produce fresh evidence in this loop (write, apply_patch, or run_command) before finishing",
      );
    }
    if (task.kind === "investigation") {
      return { summary, reproduction: await this.validateReproduction(args["reproduction"], worktree) };
    }
    if (task.touchesProductCode) {
      const diff = await worktree.git.diffAgainst(worktree.baseCommit);
      if (args["noChange"] !== undefined) {
        return { summary, noChange: validateNoChange(args["noChange"], diff, loopEvidence, toolResultTokenBudget(this.deps.contextWindow)) };
      }
      if (diff.trim() === "") {
        throw new PolishError(
          "INVALID_ARGUMENT",
          "finish rejected: coding task requires a non-empty worktree diff vs base checkpoint, " +
            "or noChange.reason after a passing acceptance check",
        );
      }
    }
    return { summary };
  }

  /**
   * An investigation ends in a command, not an opinion. It may add files for that command to run —
   * a test, a script — but not edit the project's own: a reproduction that works by changing the
   * code under suspicion proves only that the code was changed.
   */
  private async validateReproduction(value: unknown, worktree: SandboxHandle): Promise<WorkerReproduction> {
    if (value === undefined) {
      throw new PolishError(
        "INVALID_ARGUMENT",
        "finish rejected: an investigation must finish with reproduction.argv, the command that fails if the finding is real",
      );
    }
    const argv = record(value, "finish reproduction")["argv"];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part): part is string => typeof part === "string" && part !== "")) {
      throw new PolishError("INVALID_ARGUMENT", "finish rejected: reproduction.argv must be a non-empty array of strings");
    }
    const denial = this.deps.commandPolicy.check(argv);
    if (denial !== null) throw new PolishError("INVALID_ARGUMENT", `finish rejected: reproduction command is not allowed: ${denial}`);
    const edited = await worktree.git.trackedDiffAgainst(worktree.baseCommit);
    if (edited.trim() !== "") {
      throw new PolishError(
        "INVALID_ARGUMENT",
        "finish rejected: an investigation may add files but must not modify tracked ones; restore them and put the reproduction in a new file",
      );
    }
    return { argv: [...argv] };
  }

  private persistResult(input: {
    task: Task;
    messages: ChatMessage[];
    turns: AgentTurn[];
    totalTokens: number;
    status: AgentRunStatus;
    loopEvidence: LoopEvidence | null;
    output: string | null;
    reproduction: WorkerReproduction | null;
    noChange: WorkerNoChange | null;
    split: WorkerSplitRequest | null;
    startedAt: number;
    protocolHash: string | null;
    progress: AgentProgressRecord[];
  }): AgentLoopResult {
    const transcript: AgentTranscript = {
      runId: input.task.runId,
      taskId: input.task.id,
      model: this.deps.model,
      status: input.status,
      messages: input.messages,
      turns: input.turns,
      totalTokens: input.totalTokens,
      loopEvidence: input.loopEvidence,
      protocolHash: input.protocolHash,
      ...(input.progress.length === 0 ? {} : { progress: input.progress }),
      startedAt: input.startedAt,
      completedAt: this.now(),
    };
    const scrubbed = this.redact(JSON.stringify(transcript));
    const transcriptRef = this.deps.artifacts.put(
      scrubbed,
      "agent_transcript",
      `${input.task.runId}:${input.task.id}`,
    );
    const evidenceRefs = input.loopEvidence === null ? [] : loopEvidenceRefs(input.loopEvidence);
    return {
      status: input.status,
      output: input.output,
      reproduction: input.reproduction,
      noChange: input.noChange,
      split: input.split,
      loopEvidence: input.loopEvidence,
      turns: input.turns.length,
      totalTokens: input.totalTokens,
      transcriptRef,
      evidenceRefs,
    };
  }

  /**
   * The third identical `(tool, arguments, result)` with the same worktree diff ends the loop.
   * The diff is hashed on the first sighting and compared on the third, so a repeat that actually
   * changed the tree is not a stall.
   */
  private async repeatedWithoutProgress(
    name: string,
    encodedArgs: string,
    message: string,
    worktree: SandboxHandle,
    repeats: Map<string, { count: number; diffHash: string }>,
  ): Promise<{ tool: string; repeats: number } | null> {
    // `read` is how a worker looks at a file before editing it. Three reads of one file are the
    // progress tracker's case (scored at turns 8 and 12), not this one. The loops that burned a
    // budget were search and list. An accepted `finish` ends the loop before this, so a `finish`
    // that gets here was rejected: run_01m3dqgjp7s5fgzmgfhm9t sent one rejected noChange 23 times.
    if (name === "read" || name === "write" || name === "apply_patch" || name === "request_split") return null;
    const key = `${name}\n${encodedArgs}\n${sha256Hex(stableResult(name, message))}`;
    const prior = repeats.get(key);
    const count = (prior?.count ?? 0) + 1;
    if (count < 3) {
      const diffHash = prior?.diffHash ?? sha256Hex(await worktree.git.diffAgainst(worktree.baseCommit));
      repeats.set(key, { count, diffHash });
      return null;
    }
    const diffHash = sha256Hex(await worktree.git.diffAgainst(worktree.baseCommit));
    if (prior?.diffHash === diffHash) return { tool: name, repeats: count };
    repeats.set(key, { count: 1, diffHash });
    return null;
  }

  private async progressState(
    task: Task,
    worktree: SandboxHandle,
    loopEvidence: LoopEvidence,
  ): Promise<AgentProgressState | null> {
    try {
      const [diff, changedPaths] = await Promise.all([
        worktree.git.diffAgainst(task.baseCheckpointHash),
        worktree.git.changedFiles(task.baseCheckpointHash),
      ]);
      return {
        diffHash: sha256Hex(diff),
        changedPaths,
        liveEvidenceCount:
          loopEvidence.writes.length +
          loopEvidence.patches.length +
          loopEvidence.commandOutputRefs.length,
      };
    } catch {
      return null;
    }
  }
}

/**
 * What makes two results of one call the same. A command is compared by how it ended, not by what
 * it printed: test runners print their own timings (`duration_ms`), so no two runs print alike, and
 * run_01m3dqgjp7s5fgzmgfhm9t ran one passing `npm run test` 18 times on an unchanged tree.
 */
function stableResult(name: string, message: string): string {
  try {
    const parsed = JSON.parse(message) as { ok?: unknown; output?: unknown };
    if (name === "run_command" && typeof parsed.output === "object" && parsed.output !== null) {
      const { exitCode, signal, timedOut } = parsed.output as Record<string, unknown>;
      return JSON.stringify({ ok: parsed.ok, exitCode, signal, timedOut });
    }
  } catch {
    // not JSON; compared as it is
  }
  return message;
}

export function createAgentRunnerFactory(deps: AgentRunnerDeps): (index: number) => AgentRunner {
  return () => new AgentRunner(deps);
}

function toWorkerOutcome(result: AgentLoopResult): WorkerOutcome {
  if (result.status === "FINISHED") {
    return {
      status: "completed",
      evidenceRefs: result.evidenceRefs,
      transcriptRef: result.transcriptRef,
      ...(result.reproduction === null ? {} : { reproduction: result.reproduction }),
      ...(result.noChange === null ? {} : { noChange: result.noChange }),
      ...(result.split === null ? {} : { split: result.split }),
    };
  }
  return {
    status: "failed",
    error: result.status,
    evidenceRefs: result.evidenceRefs,
    transcriptRef: result.transcriptRef,
  };
}

/** Share of the worker model's context one tool result may fill; longer output is paged. */
const TOOL_RESULT_CONTEXT_SHARE = 1 / 16;
/** Assumed when the model's context window is not known. */
const DEFAULT_CONTEXT_WINDOW = 32_000;

/** How many tokens one tool result may occupy in the message the model actually sees. */
export function toolResultTokenBudget(contextWindow: number | undefined): number {
  return Math.max(Math.floor((contextWindow ?? DEFAULT_CONTEXT_WINDOW) * TOOL_RESULT_CONTEXT_SHARE), 1_000);
}

/** Share of the worker model's context its recent turns may fill verbatim; older turns are digested. */
const HISTORY_CONTEXT_SHARE = 1 / 4;

/** How many tokens of the loop's most recent turns each request carries word for word. */
export function historyTokenBudget(contextWindow: number | undefined): number {
  return Math.floor((contextWindow ?? DEFAULT_CONTEXT_WINDOW) * HISTORY_CONTEXT_SHARE);
}

/**
 * The tools page their own text. This catches what they do not — a large structured answer from
 * `repo_intel` or `request_context` — and pages its JSON the same way instead of summarising it.
 */
function boundToolResult(
  output: unknown,
  budgetTokens: number,
  page: (text: string, label: string) => unknown,
  label: string,
): { output: unknown; message: string } {
  const full = JSON.stringify({ ok: true, output });
  if (estimateTokens(full) <= budgetTokens) return { output, message: full };
  const paged = { paged: true, ...(page(JSON.stringify(output, null, 2), label) as Record<string, unknown>) };
  return { output: paged, message: JSON.stringify({ ok: true, output: paged }) };
}

function validateBudgets(deps: AgentRunnerDeps): void {
  if (!Number.isInteger(deps.maxTurns) || deps.maxTurns < 1) {
    throw new PolishError("INVALID_ARGUMENT", "maxTurns must be a positive integer");
  }
  if (!Number.isInteger(deps.maxTokens) || deps.maxTokens < 1) {
    throw new PolishError("INVALID_ARGUMENT", "maxTokens must be a positive integer");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolishError("INVALID_ARGUMENT", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function scrubUnknown(value: unknown, redact: (text: string) => string): unknown {
  if (value === undefined) return null;
  return JSON.parse(redact(JSON.stringify(value))) as unknown;
}
