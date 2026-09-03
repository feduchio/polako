import type { ChatMessage, CompletionRequest, CompletionResponse, Usage } from "../broker/types.js";
import type { ArtifactRef, ModelRef } from "../domain/common.js";
import type { Task } from "../domain/task.js";
import type { RepositoryIntelligence } from "../intel/types.js";
import type { CommandPolicy } from "../sandbox/allowlist.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import type { ArtifactStore } from "../store/artifacts.js";

export type WorkerOutcome =
  | {
      status: "completed";
      evidenceRefs?: readonly ArtifactRef[];
      transcriptRef?: ArtifactRef | null;
    }
  | {
      status: "failed" | "interrupted";
      error?: string;
      evidenceRefs?: readonly ArtifactRef[];
      transcriptRef?: ArtifactRef | null;
    };

/**
 * Narrow adapter implemented by B1's AgentRunner. Keeping the worktree handle in the
 * contract ensures all worker commands and writes remain inside the candidate sandbox.
 */
export interface CandidateWorker<TTask = Task> {
  run(task: TTask, worktree: SandboxHandle): Promise<WorkerOutcome>;
}

/** Creates a fresh worker instance per candidate so transcripts/context cannot leak across candidates. */
export type CandidateWorkerFactory<TTask = Task> = (index: number) => CandidateWorker<TTask>;

export const AGENT_TOOL_NAMES = [
  "read",
  "list",
  "search",
  "repo_intel",
  "write",
  "apply_patch",
  "run_command",
  "request_context",
  "finish",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Evidence produced inside one worker loop (writes, patches, command outputs). */
export interface LoopEvidence {
  writes: string[];
  patches: string[];
  commandOutputRefs: ArtifactRef[];
}

export interface AgentToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface AgentTurn {
  turn: number;
  assistant: Extract<ChatMessage, { role: "assistant" }>;
  usage: Usage;
  toolResults: AgentToolResult[];
}

export type AgentRunStatus = "FINISHED" | "BUDGET_EXCEEDED" | "STOPPED" | "FAILED";

export interface AgentTranscript {
  runId: string;
  taskId: string;
  model: ModelRef;
  status: AgentRunStatus;
  messages: ChatMessage[];
  turns: AgentTurn[];
  totalTokens: number;
  loopEvidence: LoopEvidence | null;
  startedAt: number;
  completedAt: number;
}

export type RequestContext = (query: string) => Promise<unknown>;

export interface AgentRunnerDeps {
  complete: (request: CompletionRequest) => Promise<CompletionResponse>;
  artifacts: ArtifactStore;
  model: ModelRef;
  commandPolicy: CommandPolicy;
  maxTurns: number;
  maxTokens: number;
  systemPrompt?: string;
  prompt?: (task: Task) => string;
  createIntelligence?: (worktreePath: string) => RepositoryIntelligence;
  requestContext?: RequestContext;
  redact?: (text: string) => string;
  now?: () => number;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  status: AgentRunStatus;
  output: string | null;
  loopEvidence: LoopEvidence | null;
  turns: number;
  totalTokens: number;
  transcriptRef: ArtifactRef;
  evidenceRefs: ArtifactRef[];
}
