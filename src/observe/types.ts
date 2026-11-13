import type { CardLedgerRow } from "../cards/ledger.js";
import type { RunControl, RunPhase } from "../domain/run.js";

export interface CouncilRoleStatus {
  role: string;
  state: "pending" | "running" | "ok" | "retry" | "fallback" | "failed" | "unavailable";
  model: string | null;
  elapsedMs: number | null;
  detail: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  retryInMs: number | null;
  fallbackTo: string | null;
}

export interface ActiveOperation {
  kind: "model" | "shell" | "worker" | "review" | "integration";
  label: string;
  role: string | null;
  model: string | null;
  elapsedMs: number;
  callId: string | null;
}

export interface WaitingState {
  kind: "retry" | "unavailable" | "output_contract" | "human";
  summary: string;
  attempt: number | null;
  maxAttempts: number | null;
  backoffMs: number | null;
  retryAt: number | null;
  fallbackTo: string | null;
  automaticRetryScheduled: boolean;
  manualResumePossible: boolean;
}

export interface HumanRequest {
  question: string;
  options: string[];
  summary: string;
}

export interface TaskCounts {
  pending: number;
  running: number;
  completed: number;
  blocked: number;
}

export interface RunStatusView {
  /** Per-card ledger of a `polako run <cards>` run; absent for a mission run. */
  cards?: CardLedgerRow[];
  runId: string;
  target: string;
  elapsedMs: number;
  phase: RunPhase;
  control: RunControl;
  lastActivity: { summary: string; ageMs: number } | null;
  progress: {
    currentTask: string | null;
    tasks: TaskCounts;
    checkpoint: string | null;
    baseline: string | null;
    diff: string | null;
  };
  council: CouncilRoleStatus[];
  active: ActiveOperation | null;
  waiting: WaitingState | null;
  humanRequest: HumanRequest | null;
  /**
   * Why a terminal run ended, for any terminal phase. `humanRequest` covers NEEDS_HUMAN only, so
   * without this a FAILED run rendered as a bare phase name and the operator saw nothing to act
   * on — which is what made terminating through FAILED unusable. Finding 54.
   */
  terminal: { code: string; summary: string; question: string | null } | null;
  verification: {
    gatesRunning: string | null;
    latestGate: string | null;
    findings: { open: number; valid: number } | null;
    cleanRounds: number | null;
  };
  resources: {
    tokens: number | null;
    usd: number | null;
    /** Calls that reported usage but no price. `usd` is a lower bound whenever this is non-zero. */
    unpricedCalls: number;
    runtime: string | null;
  };
  warning: string | null;
  stallKind: "running" | "retry" | "unavailable" | "stale" | "paused" | "terminal";
}

export interface ActivityLine {
  ts: number;
  seq: number;
  text: string;
  eventType: string;
}
