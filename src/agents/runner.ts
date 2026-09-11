import type { ModelRef } from "../domain/common.js";
import type { ChatMessage } from "../broker/types.js";
import { isBudgetError } from "../broker/quota.js";
import { BasicIntel } from "../intel/basic.js";
import type { Task } from "../domain/task.js";
import { PolishError, errorToString } from "../shared/errors.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import {
  createAgentTools,
  createLoopEvidence,
  hasLoopEvidence,
  loopEvidenceRefs,
} from "./tools.js";
import type {
  AgentLoopResult,
  AgentRunnerDeps,
  AgentRunStatus,
  AgentToolResult,
  AgentTranscript,
  AgentTurn,
  CandidateWorker,
  LoopEvidence,
  WorkerOutcome,
} from "./types.js";

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

    const messages: ChatMessage[] = [];
    if (this.deps.systemPrompt !== undefined) messages.push({ role: "system", content: this.deps.systemPrompt });
    messages.push({ role: "user", content: this.deps.prompt?.(task) ?? task.description });

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
    let acceptedEvidence: LoopEvidence | null = null;

    while (turns.length < this.deps.maxTurns && totalTokens < this.deps.maxTokens) {
      const remainingTokens = this.deps.maxTokens - totalTokens;
      let call;
      try {
        call = await this.deps.complete({
          model: this.deps.model,
          messages: [...messages],
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
          status = "FINISHED";
          break;
        }
      }
      if (status === "FINISHED") break;
      if (turns.length >= this.deps.maxTurns || totalTokens >= this.deps.maxTokens) {
        status = "BUDGET_EXCEEDED";
        break;
      }
    }

    if (status !== "FINISHED" && (turns.length >= this.deps.maxTurns || totalTokens >= this.deps.maxTokens)) {
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
      startedAt,
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
    finish: { summary: string } | null;
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
      return {
        event: { toolCallId, name, ok: true, output: scrubbed },
        message: JSON.stringify({ ok: true, output: scrubbed }),
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
  ): Promise<{ summary: string }> {
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
    if (task.touchesProductCode) {
      const diff = await worktree.git.diffAgainst(worktree.baseCommit);
      if (diff.trim() === "") {
        throw new PolishError(
          "INVALID_ARGUMENT",
          "finish rejected: coding task requires a non-empty worktree diff vs base checkpoint",
        );
      }
    }
    return { summary };
  }

  private persistResult(input: {
    task: Task;
    messages: ChatMessage[];
    turns: AgentTurn[];
    totalTokens: number;
    status: AgentRunStatus;
    loopEvidence: LoopEvidence | null;
    output: string | null;
    startedAt: number;
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
      loopEvidence: input.loopEvidence,
      turns: input.turns.length,
      totalTokens: input.totalTokens,
      transcriptRef,
      evidenceRefs,
    };
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
    };
  }
  return {
    status: "failed",
    error: result.status,
    evidenceRefs: result.evidenceRefs,
    transcriptRef: result.transcriptRef,
  };
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
