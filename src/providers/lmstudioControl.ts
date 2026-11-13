import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResidencyControl, ResidentInstance } from "../broker/residency.js";

/** Runs the `lms` CLI with `args` and returns stdout; rejects on a non-zero exit or a timeout. */
export type LmsRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

export function defaultLmsPath(): string {
  const standard = join(homedir(), ".lmstudio", "bin", "lms");
  return existsSync(standard) ? standard : "lms";
}

/** `execFile` over the `lms` binary; a model load can take a minute, hence the long timeout. */
export function lmsExecRunner(lmsPath: string = defaultLmsPath(), timeoutMs = 5 * 60_000): LmsRunner {
  return (args, signal) =>
    new Promise((resolve, reject) => {
      const options: { timeout: number; maxBuffer: number; signal?: AbortSignal } = { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 };
      if (signal !== undefined) options.signal = signal;
      execFile(lmsPath, [...args], options, (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`lms ${args.join(" ")} failed: ${(stderr || error.message).trim().slice(0, 500)}`));
      });
    });
}

export interface LmsControlOptions {
  run?: LmsRunner;
  lmsPath?: string;
  /** Context length every model is loaded with (`lms load -c`). */
  contextLength: number;
}

/**
 * Residency control through the `lms` CLI: `lms ps --json`, `lms load` and `lms unload`. Models are
 * loaded with `--parallel 1` (one prediction at a time; more only splits the speed) and
 * `--gpu max`, under their own key as identifier so the key is also the name requests use.
 */
export function lmsResidencyControl(options: LmsControlOptions): ResidencyControl {
  const run = options.run ?? lmsExecRunner(options.lmsPath);
  return {
    async loaded(signal) {
      return parseLmsPs(await run(["ps", "--json"], signal));
    },
    async load(modelKey, identifier, signal) {
      await run(["load", modelKey, "-c", String(options.contextLength), "--parallel", "1", "--gpu", "max", "--identifier", identifier, "-y"], signal);
    },
    async unload(identifier, signal) {
      await run(["unload", identifier], signal);
    },
  };
}

/** Parse `lms ps --json` (an array of loaded instances); anything unreadable is "nothing loaded". */
export function parseLmsPs(stdout: string): ResidentInstance[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ResidentInstance[] = [];
  for (const row of parsed as { identifier?: unknown; modelKey?: unknown; type?: unknown }[]) {
    if (typeof row.modelKey !== "string") continue;
    if (row.type !== undefined && row.type !== "llm") continue;
    out.push({ modelKey: row.modelKey, identifier: typeof row.identifier === "string" ? row.identifier : row.modelKey });
  }
  return out;
}
