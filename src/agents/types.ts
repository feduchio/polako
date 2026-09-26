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
      /** An investigation's claim of how to reproduce; the engine runs it, never trusts it. */
      reproduction?: WorkerReproduction;
      /** A coding task's claim that its acceptance already holds; the engine's gates decide. */
      noChange?: WorkerNoChange;
      /** A coding task's claim that it is too large for one candidate; the council decides the split. */
      split?: WorkerSplitRequest;
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
  /** The model this worker runs on. Recorded as the candidate's provenance, so it must be the
   *  same ref the worker actually sends, not a label derived from the candidate's index. */
  readonly model: ModelRef;
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
  "edit",
  "run_command",
  "request_context",
  "read_output",
  "request_split",
  "finish",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Evidence produced inside one worker loop (writes, patches, command outputs). */
export interface LoopEvidence {
  writes: string[];
  patches: string[];
  commandOutputRefs: ArtifactRef[];
  /** argv of every run_command in this loop that exited 0. */
  passedCommands: string[][];
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

export interface AgentProgressState {
  diffHash: string;
  changedPaths: string[];
  liveEvidenceCount: number;
}

export interface AgentProgressRecord {
  turn: 8 | 12;
  modelScores: { model: ModelRef; score: number }[];
  mean: number;
  stateFingerprint: string;
  decision: "continue" | "abandon";
}

export interface AgentProgressTracker {
  score(input: {
    task: Task;
    turns: readonly AgentTurn[];
    state: AgentProgressState;
  }): Promise<Omit<AgentProgressRecord, "turn" | "decision"> | null>;
}

export type AgentRunStatus =
  | "FINISHED"
  | "BUDGET_EXCEEDED"
  | "STOPPED"
  | "FAILED"
  | "ABANDONED_PROGRESS"
  | "STALLED";

export interface AgentTranscript {
  runId: string;
  taskId: string;
  model: ModelRef;
  status: AgentRunStatus;
  messages: ChatMessage[];
  turns: AgentTurn[];
  totalTokens: number;
  loopEvidence: LoopEvidence | null;
  /** Hash of the protocol bundle the instruction was composed from, so a reviewer can tell which
   *  instruction this worker actually received. */
  protocolHash: string | null;
  progress?: AgentProgressRecord[];
  startedAt: number;
  completedAt: number;
}

export type RequestContext = (query: string) => Promise<unknown>;

export interface AgentRunnerDeps {
  complete: (request: CompletionRequest) => Promise<CompletionResponse>;
  artifacts: ArtifactStore;
  model: ModelRef;
  commandPolicy: CommandPolicy;
  /** Models the broker may fall back to when `model` is rate-limited or out of quota. */
  fallbackModels?: ModelRef[];
  maxTurns: number;
  /** Tokens this attempt may spend over all its turns (`budget.maxAttemptTokens`); null is no cap. */
  maxTokens: number | null;
  /** The worker model's context window; one tool result may fill a fixed share of it. */
  contextWindow?: number;
  systemPrompt?: string;
  /** Returns the worker's instruction and the hash of the protocol bundle it was composed
   *  from. A return channel rather than a closure: a runner is reusable across tasks, and a
   *  side channel would make the recorded hash depend on call order. */
  prompt?: (task: Task) => { text: string; protocolHash: string | null };
  createProgressTracker?: (task: Task) => AgentProgressTracker | null;
  onProgress?: (task: Task, record: AgentProgressRecord) => void;
  /** Fired when the loop stops itself on a repeated tool result. The runner does not ask a model. */
  onLoopStalled?: (task: Task, info: { tool: string; repeats: number }) => void;
  createIntelligence?: (worktreePath: string) => RepositoryIntelligence;
  requestContext?: RequestContext;
  redact?: (text: string) => string;
  now?: () => number;
  signal?: AbortSignal;
  /** The project's test framework; test files it cannot run are refused at write time. */
  testFramework?: string;
}

export interface WorkerReproduction {
  argv: string[];
}

export interface WorkerNoChange {
  reason: string;
}

export interface WorkerSplitPart {
  title: string;
  acceptance: string[];
  files: string[];
}

export interface WorkerSplitRequest {
  reason: string;
  parts: WorkerSplitPart[];
}

export interface AgentLoopResult {
  status: AgentRunStatus;
  output: string | null;
  reproduction: WorkerReproduction | null;
  noChange: WorkerNoChange | null;
  split: WorkerSplitRequest | null;
  loopEvidence: LoopEvidence | null;
  turns: number;
  totalTokens: number;
  transcriptRef: ArtifactRef;
  evidenceRefs: ArtifactRef[];
}
