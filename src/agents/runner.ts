import type { ArtifactRef, ModelRef } from "../domain/common.js";
import type { ChatMessage } from "../broker/types.js";
import { isBudgetError } from "../broker/quota.js";
import { estimateTokens } from "../context/types.js";
import { BasicIntel } from "../intel/basic.js";
import type { Task } from "../domain/task.js";
import { PolishError, errorToString } from "../shared/errors.js";
import { compressOutput, renderCompressed } from "../sandbox/outputCompressor.js";
import type { ArtifactStore } from "../store/artifacts.js";
import { buildWireWindow, loopDigestCap } from "./loopWindow.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import {
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
} from "./types.js";

interface FinishArgs {
  summary: string;
  reproduction?: WorkerReproduction;
  noChange?: WorkerNoChange;
}

/**
 * "Nothing to change" is a claim like any other. The worker has to have watched a check pass on
 * the code as it stands, and must not have changed that code; the engine still re-runs the gates.
 */
function validateNoChange(value: unknown, diff: string, loopEvidence: LoopEvidence): WorkerNoChange {
  const reason = record(value, "finish noChange")["reason"];
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new PolishError("INVALID_ARGUMENT", "finish rejected: noChange.reason must be a non-empty string");
  }
  if (diff.trim() !== "") {
    throw new PolishError("INVALID_ARGUMENT", "finish rejected: noChange with a non-empty diff; revert the edits or finish without noChange");
  }
  if (loopEvidence.passedCommands.length === 0) {
    throw new PolishError(
      "INVALID_ARGUMENT",
      "finish rejected: noChange needs an acceptance check run with run_command in this loop that exited 0",
    );
  }
  return { reason };
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
    });

    let totalTokens = 0;
    let status: AgentRunStatus = "STOPPED";
    let output: string | null = null;
    let reproduction: WorkerReproduction | null = null;
    let noChange: WorkerNoChange | null = null;
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
          messages: buildWireWindow({ archive: messages, turns, digestCap }),
          tools: tools.definitions,
          maxTokens: remainingTokens,
          metadata: {
            runId: task.runId,
            purpose: "agent_run",
            role: "worker",
            taskId: task.id,
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
          (name, args, signal) => tools.execute(name, args, signal),
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
      startedAt,
      progress,
      protocolHash: composed?.protocolHash ?? null,
    });
  }

  private async executeTool(
    execute: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>,
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
      if (name === "finish") {
        const finish = await this.validateFinish(args, task, worktree, loopEvidence);
        const message = this.redact(JSON.stringify({ ok: true, accepted: true }));
        return {
          event: { toolCallId, name, ok: true, output: { accepted: true } },
          message,
          finish,
        };
      }
      const output = await execute(name, args, signal);
      const scrubbed = scrubUnknown(output, this.redact);
      const presented = name === "run_command" ? presentCommandOutput(scrubbed) : scrubbed;
      const bounded = boundToolResult(
        presented,
        toolResultTokenCap(this.deps.maxTokens),
        this.deps.artifacts,
        name,
      );
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
        return { summary, noChange: validateNoChange(args["noChange"], diff, loopEvidence) };
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
    // budget were search and list.
    if (name === "read" || name === "write" || name === "apply_patch" || name === "finish") return null;
    const key = `${name}\n${encodedArgs}\n${sha256Hex(message)}`;
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
    };
  }
  return {
    status: "failed",
    error: result.status,
    evidenceRefs: result.evidenceRefs,
    transcriptRef: result.transcriptRef,
  };
}

/** How many tokens one tool result may occupy in the message the model actually sees. */
export function toolResultTokenCap(maxTaskTokens: number): number {
  return Math.min(Math.max(Math.floor(maxTaskTokens / 8), 500), 4_000);
}

function presentCommandOutput(output: unknown): unknown {
  if (!isPlainRecord(output)) return output;
  const stdout = typeof output["stdout"] === "string" ? output["stdout"] : "";
  const stderr = typeof output["stderr"] === "string" ? output["stderr"] : "";
  const text = [stdout, stderr].filter((part) => part !== "").join("\n");
  if (estimateTokens(text) <= 400) return output;
  return {
    ...output,
    stdout: renderCompressed(compressOutput(text)),
    stderr: "",
    compressed: true,
  };
}

function boundToolResult(
  output: unknown,
  capTokens: number,
  artifacts: ArtifactStore,
  label: string,
): { output: unknown; message: string } {
  const full = JSON.stringify({ ok: true, output });
  if (estimateTokens(full) <= capTokens) return { output, message: full };
  const outputRef = artifacts.put(full, "agent_tool_output", label);
  const summary = summarizeOversized(output, outputRef);
  return {
    output: summary,
    message: JSON.stringify({ ok: true, truncated: true, outputRef, output: summary }),
  };
}

function summarizeOversized(output: unknown, outputRef: ArtifactRef): Record<string, unknown> {
  const summary: Record<string, unknown> = { truncated: true, outputRef };
  if (!isPlainRecord(output)) {
    summary["preview"] = JSON.stringify(output).slice(0, 500);
    return summary;
  }
  if (typeof output["path"] === "string") summary["path"] = output["path"];
  if (typeof output["exitCode"] === "number") summary["exitCode"] = output["exitCode"];
  if (Array.isArray(output["entries"])) summary["entryCount"] = output["entries"].length;
  if (typeof output["matches"] === "string") {
    const lines = output["matches"].split("\n").filter((line) => line.trim() !== "");
    summary["matchCount"] = lines.length;
    summary["matches"] = lines.slice(0, 20).join("\n").slice(0, 500);
  }
  if (typeof output["content"] === "string") {
    summary["content"] = output["content"].slice(0, 500);
    if (typeof output["startLine"] === "number") summary["startLine"] = output["startLine"];
    if (typeof output["endLine"] === "number") summary["endLine"] = output["endLine"];
  }
  if (typeof output["stdout"] === "string") summary["stdout"] = output["stdout"].slice(0, 500);
  return summary;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
