import { spawn } from "node:child_process";
import { PolishError } from "../shared/errors.js";

export interface RunProcessOptions {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface ProcessResult {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** true if either stream was cut at maxOutputBytes */
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  startedAt: number;
}

/**
 * Spawn without a shell, in its own process group, with a hard timeout and output caps.
 * On timeout/abort the whole group gets SIGTERM, then SIGKILL after a grace period.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const [cmd, ...args] = options.argv;
  if (!cmd) throw new PolishError("SANDBOX_ERROR", "empty argv");
  const startedAt = Date.now();

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });

    const out = new CappedBuffer(options.maxOutputBytes);
    const err = new CappedBuffer(options.maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exited = false;

    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined || exited) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const terminate = (): void => {
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
      }, 2000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new PolishError("SANDBOX_ERROR", `failed to spawn ${cmd}: ${e.message}`, { argv: options.argv }, { cause: e }));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      exited = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        argv: [...options.argv],
        cwd: options.cwd,
        exitCode: code,
        signal,
        stdout: out.toString(),
        stderr: err.toString(),
        truncated: out.truncated || err.truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        startedAt,
      });
    });

    child.stdin.on("error", () => {
      /* EPIPE when the child does not read stdin */
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.cap) {
      this.truncated = true;
      return;
    }
    const room = this.cap - this.size;
    if (chunk.byteLength > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
