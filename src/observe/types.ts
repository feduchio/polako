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
  kind: "retry" | "unavailable";
  summary: string;
  attempt: number | null;
  maxAttempts: number | null;
  backoffMs: number | null;
  retryAt: number | null;
  fallbackTo: string | null;
  automaticRetryScheduled: boolean;
  manualResumePossible: boolean;
}

export interface TaskCounts {
  pending: number;
  running: number;
  completed: number;
  blocked: number;
}

export interface RunStatusView {
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
  verification: {
    gatesRunning: string | null;
    latestGate: string | null;
    findings: { open: number; valid: number } | null;
    cleanRounds: number | null;
  };
  resources: {
    tokens: number | null;
    usd: number | null;
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
