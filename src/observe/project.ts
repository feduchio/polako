import type { ModelRef } from "../domain/common.js";
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { isTerminal } from "../domain/fsm.js";
import { RUN_PHASE_TABLE } from "../domain/run.js";
import type {
  ActiveOperation,
  ActivityLine,
  CouncilRoleStatus,
  HumanRequest,
  RunStatusView,
  TaskCounts,
  WaitingState,
} from "./types.js";

const STALE_MS = 30_000;
const COUNCIL_ROLES = ["planner", "scope_guardian", "judge"] as const;

export function projectRunStatus(run: Run, events: readonly Event[], now: number): RunStatusView {
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  const lastMeaningful = lastMeaningfulEvent(ordered);
  const lastActivity = lastMeaningful
    ? { summary: summarize(lastMeaningful), ageMs: Math.max(0, now - lastMeaningful.ts) }
    : null;
  const council = COUNCIL_ROLES.map((role) => projectCouncilRole(role, ordered, now));
  const waiting = projectWaiting(run, ordered, now);
  const humanRequest = projectHumanRequest(run, ordered);
  const terminal = projectTerminal(run);
  const active = projectActive(ordered, now);
  const stallKind = projectStall(run, active, waiting, lastActivity?.ageMs ?? null);
  const warning =
    stallKind === "stale"
      ? "run reports RUNNING but no active operation is known"
      : stallKind === "unavailable"
        ? waiting?.kind === "output_contract"
          ? "planner output contract failed; not a human question"
          : "provider unavailable; resume when the endpoint recovers"
        : null;

  return {
    runId: run.id,
    target: run.projectPath,
    elapsedMs: Math.max(0, now - run.createdAt),
    phase: run.phase,
    control: run.control,
    lastActivity,
    progress: {
      currentTask: currentTaskTitle(ordered),
      tasks: taskCounts(ordered),
      checkpoint: shortHash(run.currentCheckpointHash),
      baseline: baselineHash(run, ordered),
      diff: null,
    },
    council,
    active,
    waiting,
    humanRequest,
    terminal,
    verification: {
      gatesRunning: active?.kind === "shell" ? active.label : null,
      latestGate: latestGateSummary(ordered),
      findings: findingCounts(ordered),
      cleanRounds: cleanRoundCount(ordered),
    },
    resources: {
      tokens: tokenUsage(ordered),
      ...usdUsage(ordered),
      runtime: null,
    },
    warning,
    stallKind,
  };
}

export function projectActivity(events: readonly Event[]): ActivityLine[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq || a.ts - b.ts)
    .map((event) => ({
      ts: event.ts,
      seq: event.seq,
      text: summarize(event),
      eventType: event.type,
    }))
    .filter((line) => line.text.length > 0 && line.eventType !== "council.role_resolved" && line.eventType !== "model.observation.recorded");
}

function projectStall(
  run: Run,
  active: ActiveOperation | null,
  waiting: WaitingState | null,
  lastAgeMs: number | null,
): RunStatusView["stallKind"] {
  if (isTerminal(RUN_PHASE_TABLE, run.phase) || run.control === "STOPPED" || run.control === "KILLED") {
    return "terminal";
  }
  if (run.control === "PAUSED" || run.control === "PAUSE_REQUESTED") {
    return waiting?.kind === "unavailable" || waiting?.kind === "output_contract" ? "unavailable" : "paused";
  }
  if (waiting?.kind === "unavailable" || waiting?.kind === "output_contract") return "unavailable";
  if (waiting?.kind === "retry") return "retry";
  if (active !== null) return "running";
  if (run.control === "RUNNING" && (lastAgeMs === null || lastAgeMs >= STALE_MS)) return "stale";
  return "running";
}

function projectWaiting(run: Run, events: readonly Event[], now: number): WaitingState | null {
  const historical = latestHistoricalSchemaNeedsHuman(events);
  if (historical !== undefined && run.phase === "NEEDS_HUMAN") {
    return {
      kind: "output_contract",
      summary: "planner output contract failed",
      attempt: null,
      maxAttempts: null,
      backoffMs: null,
      retryAt: null,
      fallbackTo: null,
      automaticRetryScheduled: false,
      manualResumePossible: true,
    };
  }
  if (run.phase === "NEEDS_HUMAN") {
    return {
      kind: "human",
      summary: "waiting for input",
      attempt: null,
      maxAttempts: null,
      backoffMs: null,
      retryAt: null,
      fallbackTo: null,
      automaticRetryScheduled: false,
      manualResumePossible: true,
    };
  }
  const unavailable = [...events].reverse().find((event) => event.type === "council.unavailable");
  if (unavailable !== undefined && (run.control === "PAUSED" || run.control === "PAUSE_REQUESTED" || run.control === "RUNNING")) {
    const attempted = Array.isArray(unavailable.payload["attempted"]) ? unavailable.payload["attempted"] : [];
    const role = text(unavailable.payload["role"]) ?? "council";
    const outputContract = unavailable.payload["kind"] === "output_contract";
    return {
      kind: outputContract ? "output_contract" : "unavailable",
      summary: outputContract
        ? `${role} output contract failed`
        : `${role} unavailable${attempted.length > 0 ? ` · ${attempted.length} model(s)` : ""}`,
      attempt: null,
      maxAttempts: null,
      backoffMs: null,
      retryAt: null,
      fallbackTo: null,
      automaticRetryScheduled: unavailable.payload["automaticRetryScheduled"] === true,
      manualResumePossible: unavailable.payload["manualResumePossible"] !== false,
    };
  }
  const retry = [...events].reverse().find((event) => event.type === "model.retry_scheduled");
  const completedAfter = retry === undefined
    ? true
    : events.some((event) => event.type === "model.call" && sameCall(event, retry) && event.ts >= retry.ts);
  if (retry !== undefined && !completedAfter) {
    const retryAt = number(retry.payload["retryAt"]);
    const delayMs = number(retry.payload["delayMs"]);
    return {
      kind: "retry",
      summary: `${text(retry.payload["role"]) ?? "model"} ${text(retry.payload["errorKind"]) ?? "retry"}`,
      attempt: number(retry.payload["attempt"]),
      maxAttempts: number(retry.payload["maxAttempts"]),
      backoffMs: delayMs,
      retryAt,
      fallbackTo: null,
      automaticRetryScheduled: retryAt !== null ? retryAt > now : false,
      manualResumePossible: true,
    };
  }
  return null;
}

function projectTerminal(run: Run): { code: string; summary: string; question: string | null } | null {
  const reason = run.terminalReason;
  if (reason === null) return null;
  if (run.phase !== "FAILED" && run.phase !== "DONE" && run.phase !== "NEEDS_HUMAN") return null;
  return { code: reason.code, summary: reason.summary, question: reason.question ?? null };
}

function projectHumanRequest(run: Run, events: readonly Event[]): HumanRequest | null {
  if (run.phase !== "NEEDS_HUMAN") return null;
  if (latestHistoricalSchemaNeedsHuman(events) !== undefined) return null;
  const reason = run.terminalReason;
  if (reason?.question !== undefined && reason.question.length > 0 && !isSchemaContractReason(reason.question) && !isSchemaContractReason(reason.summary)) {
    return { question: reason.question, options: reason.options ?? [], summary: reason.summary };
  }
  const report = [...events].reverse().find((event) => event.type === "report.generated" && event.payload["kind"] === "needs_human");
  const question = text(report?.payload["question"]);
  if (question !== null && !isSchemaContractReason(question)) {
    const options = Array.isArray(report?.payload["options"])
      ? report.payload["options"].filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    return { question, options, summary: text(report?.payload["summary"]) ?? question };
  }
  const decision = [...events].reverse().find((event) => event.type === "supervisor.decision" && event.payload["decision"] === "NEEDS_HUMAN");
  const decisionReason = text(decision?.payload["reason"]);
  if (decisionReason !== null && !isSchemaContractReason(decisionReason)) {
    return { question: decisionReason, options: [], summary: decisionReason };
  }
  return null;
}

function latestHistoricalSchemaNeedsHuman(events: readonly Event[]): Event | undefined {
  return [...events].reverse().find((event) => {
    if (event.type !== "supervisor.decision") return false;
    if (event.payload["decision"] !== "NEEDS_HUMAN") return false;
    return isSchemaContractReason(text(event.payload["reason"]) ?? "") || isSchemaContractReason(text(event.payload["rationale"]) ?? "");
  });
}

function isSchemaContractReason(value: string): boolean {
  return /schema validation|output contract|valid requirement set/i.test(value);
}

function projectActive(events: readonly Event[], now: number): ActiveOperation | null {
  const started = [...events].reverse().find((event) =>
    event.type === "model.call_started" ||
    event.type === "shell.command_started" ||
    event.type === "worker.started" ||
    event.type === "review.started" ||
    event.type === "integration.started",
  );
  if (started === undefined) return null;
  if (isClosed(started, events)) return null;
  const elapsedMs = Math.max(0, now - started.ts);
  if (started.type === "model.call_started") {
    return {
      kind: "model",
      label: `${text(started.payload["role"]) ?? "model"} ${displayModel(started.payload["model"])}`,
      role: text(started.payload["role"]),
      model: displayModel(started.payload["model"]),
      elapsedMs,
      callId: text(started.payload["callId"]),
    };
  }
  if (started.type === "shell.command_started") {
    const command = started.payload["command"];
    const cmd = Array.isArray(command) ? command.map(String).join(" ") : text(command) ?? "command";
    return { kind: "shell", label: cmd, role: null, model: null, elapsedMs, callId: null };
  }
  if (started.type === "worker.started") {
    return {
      kind: "worker",
      label: `Worker ${text(started.payload["candidateId"]) ?? ""}`.trim(),
      role: "worker",
      model: displayModel(started.payload["model"]),
      elapsedMs,
      callId: text(started.payload["candidateId"]),
    };
  }
  if (started.type === "review.started") {
    return { kind: "review", label: "Review", role: "reviewer", model: null, elapsedMs, callId: null };
  }
  return { kind: "integration", label: "Integration", role: null, model: null, elapsedMs, callId: null };
}

function isClosed(started: Event, events: readonly Event[]): boolean {
  return events.some((event) => {
    if (event.ts < started.ts) return false;
    if (started.type === "model.call_started") {
      return event.type === "model.call" && sameCall(event, started);
    }
    if (started.type === "shell.command_started") {
      return event.type === "shell.command" || event.type === "baseline.snapshotted" || event.type === "candidate.gated";
    }
    if (started.type === "worker.started") {
      return event.type === "candidate.created" || event.type === "candidate.state_changed";
    }
    if (started.type === "review.started") return event.type === "review.finished";
    if (started.type === "integration.started") return event.type === "integration.finished";
    return false;
  });
}

function sameCall(a: Event, b: Event): boolean {
  const aId = text(a.payload["callId"]);
  const bId = text(b.payload["callId"]);
  if (aId !== null && bId !== null) return aId === bId;
  return displayModel(a.payload["model"]) === displayModel(b.payload["model"]) &&
    text(a.payload["role"]) === text(b.payload["role"]);
}

function projectCouncilRole(role: string, events: readonly Event[], now: number): CouncilRoleStatus {
  const resolved = [...events].reverse().find((event) => event.type === "council.role_resolved" && event.payload["role"] === role);
  const started = [...events].reverse().find((event) => event.type === "model.call_started" && councilRoleOf(event) === role);
  const finished = [...events].reverse().find((event) => event.type === "model.call" && councilRoleOf(event) === role);
  const retry = [...events].reverse().find((event) => event.type === "model.retry_scheduled" && councilRoleOf(event) === role);
  const fallback = [...events].reverse().find((event) => event.type === "model.fallback_selected" && event.payload["role"] === role);
  const unavailable = [...events].reverse().find((event) => event.type === "council.unavailable" && (event.payload["role"] === role || event.payload["role"] === null));

  const model = displayModel(finished?.payload["model"] ?? started?.payload["model"] ?? resolvedModel(resolved));
  if (finished?.payload["ok"] === true && (started === undefined || finished.ts >= started.ts)) {
    return {
      role,
      state: "ok",
      model,
      elapsedMs: number(finished.payload["latencyMs"]),
      detail: null,
      attempt: number(finished.payload["attempts"]),
      maxAttempts: null,
      retryInMs: null,
      fallbackTo: fallback === undefined ? null : displayModel(fallback.payload["to"]),
    };
  }
  if (retry !== undefined && (finished === undefined || retry.ts > finished.ts)) {
    const retryAt = number(retry.payload["retryAt"]) ?? now;
    return {
      role,
      state: "retry",
      model: displayModel(retry.payload["model"]),
      elapsedMs: null,
      detail: text(retry.payload["errorKind"]),
      attempt: number(retry.payload["attempt"]),
      maxAttempts: number(retry.payload["maxAttempts"]),
      retryInMs: Math.max(0, retryAt - now),
      fallbackTo: null,
    };
  }
  if (started !== undefined && (finished === undefined || started.ts > finished.ts)) {
    return {
      role,
      state: fallback !== undefined && fallback.ts >= started.ts ? "fallback" : "running",
      model: displayModel(started.payload["model"]),
      elapsedMs: Math.max(0, now - started.ts),
      detail: fallback === undefined ? null : `fallback → ${displayModel(fallback.payload["to"])}`,
      attempt: null,
      maxAttempts: null,
      retryInMs: null,
      fallbackTo: fallback === undefined ? null : displayModel(fallback.payload["to"]),
    };
  }
  if (unavailable !== undefined) {
    return {
      role,
      state: "unavailable",
      model,
      elapsedMs: null,
      detail: text(unavailable.payload["message"]),
      attempt: null,
      maxAttempts: null,
      retryInMs: null,
      fallbackTo: null,
    };
  }
  if (finished?.payload["ok"] === false) {
    return {
      role,
      state: "failed",
      model,
      elapsedMs: number(finished.payload["latencyMs"]),
      detail: text(finished.payload["error"]),
      attempt: number(finished.payload["attempts"]),
      maxAttempts: null,
      retryInMs: null,
      fallbackTo: null,
    };
  }
  return {
    role,
    state: "pending",
    model,
    elapsedMs: null,
    detail: null,
    attempt: null,
    maxAttempts: null,
    retryInMs: null,
    fallbackTo: null,
  };
}

function councilRoleOf(event: Event): string | null {
  const role = text(event.payload["role"]);
  if (role === "planner" || role === "scope_guardian" || role === "judge") return role;
  const purpose = text(event.payload["purpose"]) ?? "";
  if (purpose.includes("planner")) return "planner";
  if (purpose.includes("scope")) return "scope_guardian";
  if (purpose.includes("judge")) return "judge";
  return role;
}

function resolvedModel(event: Event | undefined): ModelRef | string | null {
  if (event === undefined) return null;
  const provider = text(event.payload["provider"]);
  const model = text(event.payload["model"]);
  if (provider !== null && model !== null) return { provider, model };
  return model;
}

function lastMeaningfulEvent(events: readonly Event[]): Event | undefined {
  return [...events].reverse().find((event) => !event.type.startsWith("job.") && event.type !== "model.observation.recorded");
}

function taskCounts(events: readonly Event[]): TaskCounts {
  const states = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "task.created" && event.type !== "task.state_changed") continue;
    const task = asRecord(event.payload["task"]);
    const id = text(task?.["id"] ?? event.payload["taskId"]);
    if (id === null) continue;
    const state = text(event.payload["to"]) ?? text(task?.["state"]) ?? "PENDING";
    states.set(id, state);
  }
  const counts: TaskCounts = { pending: 0, running: 0, completed: 0, blocked: 0 };
  for (const state of states.values()) {
    if (state === "BLOCKED") counts.blocked += 1;
    else if (state === "DONE" || state === "INTEGRATED" || state === "GATED") counts.completed += 1;
    else if (state === "RUNNING" || state === "IMPLEMENTING") counts.running += 1;
    else counts.pending += 1;
  }
  return counts;
}

function currentTaskTitle(events: readonly Event[]): string | null {
  const running = [...events].reverse().find((event) => {
    if (event.type !== "task.state_changed" && event.type !== "task.created") return false;
    const task = asRecord(event.payload["task"]);
    const state = text(event.payload["to"]) ?? text(task?.["state"]);
    return state === "RUNNING" || state === "READY";
  });
  const task = asRecord(running?.payload["task"]);
  return text(task?.["title"]);
}

function baselineHash(run: Run, events: readonly Event[]): string | null {
  if (run.baselineId !== null) return shortHash(run.baselineId);
  const snap = [...events].reverse().find((event) => event.type === "baseline.snapshotted");
  const baseline = asRecord(snap?.payload["baseline"]);
  return shortHash(text(baseline?.["commitHash"]));
}

function latestGateSummary(events: readonly Event[]): string | null {
  const gated = [...events].reverse().find((event) => event.type === "candidate.gated" || event.type === "baseline.snapshotted");
  return gated === undefined ? null : summarize(gated);
}

function findingCounts(events: readonly Event[]): { open: number; valid: number } | null {
  let open = 0;
  let valid = 0;
  let any = false;
  for (const event of events) {
    if (event.type === "finding.raised") {
      any = true;
      open += 1;
    }
    if (event.type === "finding.validated") {
      any = true;
      const verdict = text(event.payload["verdict"])?.toLowerCase();
      if (verdict === "valid") valid += 1;
    }
  }
  return any ? { open, valid } : null;
}

function cleanRoundCount(events: readonly Event[]): number | null {
  const n = events.filter((event) => event.type === "clean_round.recorded").length;
  return n > 0 ? n : null;
}

function tokenUsage(events: readonly Event[]): number | null {
  let tokens = 0;
  let any = false;
  for (const event of events) {
    if (event.type !== "model.call") continue;
    const usage = asRecord(event.payload["usage"]);
    const input = number(usage?.["inputTokens"]) ?? 0;
    const output = number(usage?.["outputTokens"]) ?? 0;
    if (usage !== null) {
      any = true;
      tokens += input + output;
    }
  }
  return any ? tokens : null;
}

/**
 * A partially priced run summed to a bare number is a lower bound presented as a total, so the
 * count of what was left out travels with it. A call with no `usage` at all consumed nothing and is
 * not unpriced spend — only a priced-call-shaped one missing its `costUsd` is.
 */
function usdUsage(events: readonly Event[]): { usd: number | null; unpricedCalls: number } {
  let usd = 0;
  let any = false;
  let unpricedCalls = 0;
  for (const event of events) {
    if (event.type !== "model.call") continue;
    const usage = asRecord(event.payload["usage"]);
    if (usage === null) continue;
    const cost = number(usage["costUsd"]);
    if (cost === null) {
      unpricedCalls += 1;
      continue;
    }
    any = true;
    usd += cost;
  }
  return { usd: any ? usd : null, unpricedCalls };
}

export function summarize(event: Event): string {
  switch (event.type) {
    case "project.discovered": {
      const profile = asRecord(event.payload["profile"]);
      const pm = text(profile?.["packageManager"]);
      const fw = text(profile?.["framework"]);
      return `Project discovered${pm !== null || fw !== null ? ` · ${[pm, fw].filter(Boolean).join(" / ")}` : ""}`;
    }
    case "baseline.snapshotted": {
      const baseline = asRecord(event.payload["baseline"]);
      const checks = Array.isArray(baseline?.["checks"]) ? baseline["checks"] : [];
      const passed = checks.filter((item) => asRecord(item)?.["status"] === "pass").length;
      return passed > 0 ? `✓ Baseline · ${passed}/${checks.length} checks` : "Baseline captured";
    }
    case "run.phase_changed": {
      const nested = asRecord(event.payload["run"]);
      const phase = text(event.payload["to"]) ?? text(nested?.["phase"]);
      if (phase === "INTERPRETING_MISSION") return "Interpreting mission";
      if (phase === "NEEDS_HUMAN") {
        const reason = asRecord(nested?.["terminalReason"]);
        const question = text(reason?.["question"]);
        if (question !== null && !isSchemaContractReason(question)) return `Needs human · ${question}`;
        if (isSchemaContractReason(text(reason?.["summary"]) ?? "") || isSchemaContractReason(question ?? "")) {
          return "Planner output contract failed";
        }
        return "Phase NEEDS_HUMAN";
      }
      return phase !== null ? `Phase ${phase}` : "Phase changed";
    }
    case "model.call_started": {
      const stage = councilPurposeStage(text(event.payload["purpose"]));
      const role = text(event.payload["role"]) ?? "model";
      const model = displayModel(event.payload["model"]);
      return `→ ${role} · ${model}${stage !== null ? ` · ${stage}` : ""}`;
    }
    case "model.call": {
      const ok = event.payload["ok"] !== false;
      const role = text(event.payload["role"]) ?? "model";
      const ms = number(event.payload["latencyMs"]);
      if (ok) return `✓ ${role}${ms !== null ? ` · ${formatDuration(ms)}` : ""}`;
      return `! ${role} · ${text(event.payload["error"]) ?? "failed"}`;
    }
    case "model.retry_scheduled": {
      const delay = number(event.payload["delayMs"]);
      return `↻ retry in ${delay !== null ? formatDuration(delay) : "a moment"}`;
    }
    case "model.fallback_selected":
      return `⇢ fallback · ${displayModel(event.payload["to"])}`;
    case "model.output_invalid":
      return `! ${text(event.payload["role"]) ?? "planner"} output invalid · ${text(event.payload["summary"]) ?? "schema"}`;
    case "model.output_repair_attempted": {
      const attempt = number(event.payload["attempt"]) ?? 1;
      const max = number(event.payload["maxAttempts"]) ?? attempt;
      return `↻ repair ${attempt}/${max}`;
    }
    case "council.unavailable":
      return event.payload["kind"] === "output_contract"
        ? `! ${text(event.payload["role"]) ?? "planner"} output contract failed`
        : `! ${text(event.payload["role"]) ?? "council"} unavailable`;
    case "council.role_resolved":
      return `${text(event.payload["role"]) ?? "role"} resolved · ${text(event.payload["model"]) ?? displayModel(event.payload)}`;
    case "shell.command_started": {
      const command = event.payload["command"];
      const cmd = Array.isArray(command) ? command.map(String).join(" ") : text(command) ?? "command";
      return `→ ${cmd}`;
    }
    case "shell.command":
      return `✓ ${text(event.payload["command"]) ?? "command"}`;
    case "worker.started":
      return `→ Worker${text(event.payload["candidateId"]) !== null ? ` · ${text(event.payload["candidateId"])}` : ""}`;
    case "task.created": {
      const task = asRecord(event.payload["task"]);
      return `Task ${text(task?.["title"]) ?? text(task?.["id"]) ?? "created"}`;
    }
    case "candidate.created":
      return `→ Candidate ${text(asRecord(event.payload["candidate"])?.["id"]) ?? ""}`.trim();
    case "candidate.gated":
      return `✓ Gates ${text(event.payload["verdict"] ?? event.payload["status"]) ?? "recorded"}`;
    case "review.started":
      return "→ Review";
    case "review.finished":
      return "✓ Review";
    case "integration.started":
      return "→ Integration";
    case "integration.finished":
      return `✓ Integration · ${text(event.payload["status"]) ?? "complete"}`;
    case "finding.raised":
      return `! Finding ${text(event.payload["claim"]) ?? ""}`.trim();
    case "finding.validated":
      return `✓ Finding ${text(event.payload["verdict"]) ?? "validated"}`;
    case "checkpoint.created":
      return "✓ Checkpoint advanced";
    case "clean_round.recorded":
      return "✓ Clean round";
    case "mission.interpreted":
      return "Mission interpreted";
    case "report.generated": {
      if (event.payload["kind"] === "needs_human") {
        const question = text(event.payload["question"]);
        if (question !== null && !isSchemaContractReason(question)) return `Needs human · ${question}`;
      }
      return "";
    }
    case "run.control_changed": {
      const nested = asRecord(event.payload["run"]);
      return `Control ${text(nested?.["control"]) ?? "changed"}`;
    }
    case "supervisor.decision": {
      const decision = text(event.payload["decision"]) ?? "decided";
      const reason = text(event.payload["reason"]);
      if (reason !== null && isSchemaContractReason(reason)) return `Council ${decision} · output contract failed`;
      return `Council ${decision}`;
    }
    default:
      return "";
  }
}

export function displayModel(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return humanizeModel(value);
  const record = asRecord(value);
  if (record === null) return "—";
  const model = text(record["model"]);
  if (model === null) return "—";
  return humanizeModel(model);
}

export function humanizeModel(value: string): string {
  const stripped = stripModelId(value);
  const identity = stripped.includes("/") ? (stripped.slice(stripped.lastIndexOf("/") + 1) || stripped) : stripped;
  return identity
    .split(/[-_]+/)
    .filter((part) => part.length > 0 && part !== "z" && part !== "ai")
    .map((part) => titleModelPart(part))
    .join(" ");
}

function stripModelId(value: string): string {
  let name = value.replace(/:free$/i, "").replace(/^models\//, "");
  name = name.replace(/^(openrouter|gemini|groq|openai|anthropic|google):/i, "");
  return name;
}

function titleModelPart(part: string): string {
  if (part.toLowerCase() === "glm") return "GLM";
  if (part.toLowerCase() === "minimax") return "MiniMax";
  if (/^m\d+$/i.test(part)) return part.toUpperCase();
  return part.charAt(0).toUpperCase() + part.slice(1);
}

export function councilPurposeStage(purpose: string | null): string | null {
  if (purpose === null || purpose === "") return null;
  if (purpose.startsWith("council_intake_")) return "intake";
  if (purpose.startsWith("council_decompose_")) return "decompose";
  return purpose;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  if (totalSec >= 60) return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const tenths = Math.floor((ms % 1000) / 100);
  return tenths > 0 ? `${totalSec}.${tenths}s` : `${totalSec}s`;
}

export function formatAge(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms ago`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s ago`;
}

function shortHash(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  return value.length > 12 ? value.slice(0, 12) : value;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
