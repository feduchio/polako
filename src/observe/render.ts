import type { Run } from "../domain/run.js";
import { formatAge, formatDuration, projectActivity, projectRunStatus } from "./project.js";
import type { ActivityLine, CouncilRoleStatus, RunStatusView } from "./types.js";

const DASH = "—";

export function renderRunStatus(view: RunStatusView): string {
  const last = view.lastActivity === null
    ? DASH
    : `${view.lastActivity.summary} · ${formatAge(view.lastActivity.ageMs)}`;
  const lines = [
    `Polish · ${view.runId}`,
    `TARGET  ${view.target}`,
    `STATE   ${view.phase} / ${view.control}`,
    `TIME    ${formatClock(view.elapsedMs)}`,
    `LAST    ${last}`,
    "",
    "COUNCIL",
    ...renderCouncil(view.council),
    "",
    "PROGRESS",
    `Task    ${view.progress.currentTask ?? "No coding tasks yet."}`,
    `Counts  pending ${view.progress.tasks.pending} · running ${view.progress.tasks.running} · completed ${view.progress.tasks.completed} · blocked ${view.progress.tasks.blocked}`,
    `Check   ${view.progress.checkpoint ?? DASH}${view.progress.baseline !== null ? ` (baseline ${view.progress.baseline})` : ""}`,
    view.progress.diff !== null ? `Diff    ${view.progress.diff}` : null,
    "",
    "ACTIVE",
    view.active === null
      ? "none"
      : `${view.active.label}${view.active.model !== null && view.active.model !== "—" ? ` · ${view.active.model}` : ""} · ${formatDuration(view.active.elapsedMs)}`,
    "",
    "WAITING",
    renderWaiting(view),
    ...renderHuman(view),
    "",
    "VERIFICATION",
    `Gates     ${view.verification.gatesRunning ?? view.verification.latestGate ?? DASH}`,
    `Findings  ${view.verification.findings === null ? DASH : `${view.verification.findings.open} open / ${view.verification.findings.valid} valid`}`,
    `Rounds    ${view.verification.cleanRounds ?? DASH}`,
    "",
    "RESOURCES",
    `Tokens   ${view.resources.tokens ?? DASH}`,
    `USD      ${view.resources.usd === null ? DASH : view.resources.usd.toFixed(4)}`,
    `Runtime  ${view.resources.runtime ?? DASH}`,
  ];
  if (view.warning !== null) {
    lines.push("", `WARNING  ${view.warning}`);
  }
  return lines.filter((line) => line !== null).join("\n") + "\n";
}

export function renderWatchFrame(view: RunStatusView, feed: readonly ActivityLine[], opts: { color?: boolean } = {}): string {
  const header = renderRunStatus(view).trimEnd();
  const body = feed.length === 0
    ? "(no activity yet)"
    : feed.map((line) => `${formatClockTime(line.ts)}  ${line.text}`).join("\n");
  const color = opts.color === true;
  const divider = color ? "\u001b[2m────────────────────────────────\u001b[0m" : "────────────────────────────────";
  return `${header}\n\n${divider}\n${body}\n`;
}

export function renderActivityFeed(events: Parameters<typeof projectActivity>[0]): string {
  return projectActivity(events)
    .map((line) => `${formatClockTime(line.ts)}  ${line.text}`)
    .join("\n");
}

export function statusFromRun(run: Run, events: Parameters<typeof projectRunStatus>[1], now: number): string {
  return renderRunStatus(projectRunStatus(run, events, now));
}

function renderCouncil(roles: readonly CouncilRoleStatus[]): string[] {
  if (roles.length === 0) return [DASH];
  const lines: string[] = [];
  for (const role of roles) {
    const mark =
      role.state === "ok" ? "✓" :
      role.state === "running" || role.state === "fallback" ? "◌" :
      role.state === "retry" ? "↻" :
      role.state === "unavailable" || role.state === "failed" ? "!" :
      "·";
    const model = role.model ?? DASH;
    const extra =
      role.state === "running" && role.elapsedMs !== null ? `running ${formatDuration(role.elapsedMs)}` :
      role.state === "ok" && role.elapsedMs !== null ? formatDuration(role.elapsedMs) :
      role.state === "retry" ? (role.detail ?? "retry") :
      role.state === "unavailable" ? "unavailable" :
      role.state === "failed" ? (role.detail ?? "failed") :
      role.state;
    lines.push(`${mark} ${padRole(role.role)}  ${padModel(model)}  ${extra}`);
    if (role.state === "retry" && role.attempt !== null && role.retryInMs !== null) {
      lines.push(`                 retry ${role.attempt}/${role.maxAttempts ?? role.attempt} in ${formatDuration(role.retryInMs)}`);
    }
    if (role.fallbackTo !== null && role.state !== "ok") {
      lines.push(`                 fallback → ${role.fallbackTo}`);
    }
  }
  return lines;
}

function renderWaiting(view: RunStatusView): string {
  if (view.waiting === null) return DASH;
  const parts = [view.waiting.summary];
  if (view.waiting.attempt !== null) {
    parts.push(`attempt ${view.waiting.attempt}/${view.waiting.maxAttempts ?? view.waiting.attempt}`);
  }
  if (view.waiting.backoffMs !== null) parts.push(`backoff ${formatDuration(view.waiting.backoffMs)}`);
  if (view.waiting.fallbackTo !== null) parts.push(`fallback → ${view.waiting.fallbackTo}`);
  parts.push(view.waiting.automaticRetryScheduled ? "auto-retry scheduled" : "no auto-retry");
  if (view.waiting.manualResumePossible) parts.push("manual resume possible");
  return parts.join(" · ");
}

function renderHuman(view: RunStatusView): string[] {
  if (view.phase === "NEEDS_HUMAN" && view.waiting?.kind === "output_contract") {
    return ["", "HUMAN", "not a human question · planner output failed the schema contract"];
  }
  if (view.humanRequest === null) {
    if (view.phase === "NEEDS_HUMAN") {
      return ["", "HUMAN", "decision required (see report)"];
    }
    return [];
  }
  const lines = ["", "HUMAN", view.humanRequest.question];
  view.humanRequest.options.forEach((option, index) => {
    lines.push(`${index + 1}. ${option}`);
  });
  return lines;
}

function padRole(role: string): string {
  const names: Record<string, string> = { planner: "planner", scope_guardian: "scope", judge: "judge" };
  return (names[role] ?? role).padEnd(8);
}

function padModel(model: string): string {
  return model.padEnd(22);
}

function formatClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatClockTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "00:00:00";
  return date.toISOString().slice(11, 19);
}
