import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { isTerminal } from "../domain/fsm.js";
import { RUN_CONTROL_TABLE, RUN_PHASE_TABLE } from "../domain/run.js";
import { projectActivity, projectRunStatus } from "../observe/project.js";
import { renderActivityFeed, renderRunStatus, renderWatchFrame } from "../observe/render.js";
import { callDaemon } from "./client.js";

export interface WatchOptions {
  runId: string;
  json: boolean;
  verbose: boolean;
  color: boolean;
  isTTY: boolean;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  stdout?: { write(chunk: string): boolean };
  rpc?: {
    status(runId: string): Promise<Run>;
    log(runId: string, afterSeq: number): Promise<Event[]>;
  };
}

export async function runWatch(options: WatchOptions): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const pollMs = options.pollMs ?? 400;
  const rpc = options.rpc ?? {
    status: (runId) => callDaemon<Run>("status", { runId }),
    log: (runId, afterSeq) => callDaemon<Event[]>("log", { runId, afterSeq }),
  };
  let afterSeq = -1;
  const events: Event[] = [];
  let printedSeq = -1;
  let first = true;

  for (;;) {
    if (options.signal?.aborted) return;
    const run = await rpc.status(options.runId);
    const incoming = await rpc.log(options.runId, afterSeq);
    for (const event of incoming) {
      events.push(event);
      afterSeq = Math.max(afterSeq, event.seq);
    }
    const now = (options.now ?? Date.now)();
    const view = projectRunStatus(run, events, now);
    const feed = projectActivity(events);
    if (options.json) {
      stdout.write(`${JSON.stringify({ type: "status", view })}\n`);
      for (const event of incoming) {
        stdout.write(`${JSON.stringify({ type: "event", event })}\n`);
      }
    } else if (options.isTTY) {
      stdout.write(`\x1b[2J\x1b[H${renderWatchFrame(view, options.verbose ? feed : feed.slice(-24), { color: options.color })}`);
    } else {
      if (first) stdout.write(renderRunStatus(view));
      const fresh = feed.filter((line) => line.seq > printedSeq);
      if (fresh.length > 0) stdout.write(`${fresh.map((line) => formatFeedLine(line.ts, line.text)).join("\n")}\n`);
      printedSeq = feed.at(-1)?.seq ?? printedSeq;
    }
    first = false;
    if (isWatchSettled(run)) return;
    await sleep(pollMs, options.signal);
  }
}

export function renderLog(events: readonly Event[], json: boolean): string {
  if (json) return events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
  const body = renderActivityFeed(events);
  return body.length > 0 ? `${body}\n` : "";
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
