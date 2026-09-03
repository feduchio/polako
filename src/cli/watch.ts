import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { isTerminal } from "../domain/fsm.js";
import { RUN_CONTROL_TABLE, RUN_PHASE_TABLE } from "../domain/run.js";
import { projectActivity, projectRunStatus } from "../observe/project.js";
import { renderActivityFeed, renderRunStatus, renderWatchFrame } from "../observe/render.js";
import { callDaemon } from "./client.js";
import { attachWatchScreen, paintWatchFrame } from "./tty.js";

const HEARTBEAT_MS = 1_000;
const DEFAULT_POLL_MS = 400;
const CONTROL_RPC = new Set(["pause", "resume", "stop", "kill"]);

export interface WatchOptions {
  runId: string;
  json: boolean;
  verbose: boolean;
  color: boolean;
  isTTY: boolean;
  plain?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  stdout?: { write(chunk: string): boolean; rows?: number };
  rows?: number;
  rpc?: {
    status(runId: string): Promise<Run>;
    log(runId: string, afterSeq: number): Promise<Event[]>;
  };
}

export type WatchExitReason = "settled" | "detached";

export async function runWatch(options: WatchOptions): Promise<WatchExitReason> {
  const stdout = options.stdout ?? process.stdout;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const rpc = options.rpc ?? {
    status: (runId) => callDaemon<Run>("status", { runId }),
    log: (runId, afterSeq) => callDaemon<Event[]>("log", { runId, afterSeq }),
  };
  const fullscreen = options.isTTY && !options.json && options.plain !== true;
  const restore = fullscreen ? attachWatchScreen(stdout) : () => undefined;
  const abort = new AbortController();
  if (options.signal?.aborted) abort.abort();
  options.signal?.addEventListener("abort", () => {
    abort.abort();
  }, { once: true });
  const handleProcessSignals = options.signal === undefined;
  const onProcessSignal = (): void => {
    abort.abort();
  };
  if (handleProcessSignals) {
    process.on("SIGINT", onProcessSignal);
    process.on("SIGTERM", onProcessSignal);
  }
  let afterSeq = -1;
  const events: Event[] = [];
  let printedSeq = -1;
  let first = true;
  let lastPaintAt = 0;
  let lastFrame = "";
  let lastView: ReturnType<typeof projectRunStatus> | null = null;
  let reason: WatchExitReason = "settled";

  try {
    for (;;) {
      if (abort.signal.aborted) {
        reason = "detached";
        break;
      }
      const run = await rpc.status(options.runId);
      const incoming = await rpc.log(options.runId, afterSeq);
      for (const event of incoming) {
        events.push(event);
        afterSeq = Math.max(afterSeq, event.seq);
      }
      const now = (options.now ?? Date.now)();
      const view = projectRunStatus(run, events, now);
      lastView = view;
      const feed = projectActivity(events);
      if (options.json) {
        stdout.write(`${JSON.stringify({ type: "status", view })}\n`);
        for (const event of incoming) {
          stdout.write(`${JSON.stringify({ type: "event", event })}\n`);
        }
      } else if (fullscreen) {
        const rows = options.rows ?? stdout.rows ?? (typeof process.stdout.rows === "number" ? process.stdout.rows : 24);
        const headerLines = renderRunStatus(view).split("\n").length + 3;
        const feedCap = Math.max(3, Math.min(options.verbose ? 48 : 24, rows - headerLines));
        const shown = feed.slice(-feedCap);
        const frame = renderWatchFrame(view, shown, { color: options.color });
        const heartbeatDue = now - lastPaintAt >= HEARTBEAT_MS;
        if (first || incoming.length > 0 || heartbeatDue || frame !== lastFrame) {
          paintWatchFrame(stdout, frame);
          lastFrame = frame;
          lastPaintAt = now;
        }
      } else {
        if (first) stdout.write(renderRunStatus(view));
        const fresh = feed.filter((line) => line.seq > printedSeq);
        if (fresh.length > 0) stdout.write(`${fresh.map((line) => formatFeedLine(line.ts, line.text)).join("\n")}\n`);
        printedSeq = feed.at(-1)?.seq ?? printedSeq;
      }
      first = false;
      if (isWatchSettled(run)) break;
      await sleep(pollMs, abort.signal);
    }
  } finally {
    restore();
    if (handleProcessSignals) {
      process.off("SIGINT", onProcessSignal);
      process.off("SIGTERM", onProcessSignal);
    }
  }
  if (reason === "settled" && fullscreen && lastView !== null) {
    stdout.write(renderRunStatus(lastView));
  }
  return reason;
}

export function renderLog(events: readonly Event[], json: boolean): string {
  if (json) return events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
  const body = renderActivityFeed(events);
  return body.length > 0 ? `${body}\n` : "";
}

export function isExecutionControlRpc(method: string): boolean {
  return CONTROL_RPC.has(method);
}

function isWatchSettled(run: Run): boolean {
  return isTerminal(RUN_PHASE_TABLE, run.phase) || isTerminal(RUN_CONTROL_TABLE, run.control);
}

function formatFeedLine(ts: number, text: string): string {
  const date = new Date(ts);
  const clock = Number.isNaN(date.getTime()) ? "00:00:00" : date.toISOString().slice(11, 19);
  return `${clock}  ${text}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
