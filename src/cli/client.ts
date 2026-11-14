import { BRAND } from "../shared/brand.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { polishHome, polishLockPath, polishPidPath, polishSocketPath } from "../daemon/main.js";
import { rpcCall } from "../daemon/rpc.js";

export async function callDaemon<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const socketPath = polishSocketPath();
  try {
    return await rpcCall<T>(socketPath, method, params);
  } catch (error) {
    if (!isConnectionError(error)) throw error;
  }
  await autostartDaemon();
  return rpcCall<T>(socketPath, method, params);
}

export async function autostartDaemon(): Promise<void> {
  const home = polishHome();
  const socketPath = polishSocketPath(home);
  mkdirSync(home, { recursive: true });
  const builtEntry = fileURLToPath(new URL("../daemon/main.js", import.meta.url));
  const sourceEntry = fileURLToPath(new URL("../daemon/main.ts", import.meta.url));
  const child = existsSync(builtEntry)
    ? spawn(process.execPath, [builtEntry], { detached: true, stdio: "ignore", env: process.env })
    : spawn(process.execPath, ["--import", "tsx", sourceEntry], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
  child.unref();

  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    try {
      await rpcCall(socketPath, "daemon.ping", {}, 250);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${BRAND.daemon} did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function isConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export interface DaemonInfo {
  pid: number;
  home: string;
  features?: string[];
  startedAt?: number;
  entry?: string | null;
  builtAt?: number | null;
}

/**
 * Whether the running daemon can serve what the client is about to ask. A daemon from an older
 * build ignores `run` parameters it does not know, so the failure has to be raised here, with the
 * way out, rather than discovered hours later as a run that does something else.
 */
export function daemonProblem(info: DaemonInfo, required: readonly string[], clientBuiltAt: number | null): { fatal: string | null; warning: string | null } {
  const missing = required.filter((feature) => !(info.features ?? []).includes(feature));
  const where = info.entry ?? "an unknown entry";
  if (missing.length > 0) {
    return {
      fatal: `the running ${BRAND.daemon} (pid ${String(info.pid)}, ${where}) predates ${missing.join(", ")} support and would ignore it. Restart it: ${BRAND.cli} daemon restart`,
      warning: null,
    };
  }
  if (clientBuiltAt !== null && info.builtAt !== undefined && info.builtAt !== null && info.builtAt < clientBuiltAt - 1_000) {
    return { fatal: null, warning: `the running ${BRAND.daemon} (pid ${String(info.pid)}) is older than this ${BRAND.cli} build; restart it with: ${BRAND.cli} daemon restart` };
  }
  return { fatal: null, warning: null };
}

/** Ping the daemon (starting one if none runs) and refuse a daemon that cannot serve `required`. */
export async function requireDaemon(required: readonly string[], call: <T>(method: string, params?: Record<string, unknown>) => Promise<T> = callDaemon): Promise<DaemonInfo> {
  const info = await call<DaemonInfo>("daemon.ping");
  const problem = daemonProblem(info, required, ownBuildTime());
  if (problem.fatal !== null) throw new Error(problem.fatal);
  if (problem.warning !== null) process.stderr.write(`warning: ${problem.warning}\n`);
  return info;
}

function ownBuildTime(): number | null {
  try {
    return statSync(fileURLToPath(new URL("../daemon/main.js", import.meta.url))).mtimeMs;
  } catch {
    return null;
  }
}

/** Stop the daemon the CLI talks to and wait until its socket is gone. Returns the pid stopped, or null if none ran. */
export async function stopDaemon(timeoutMs = 30_000, force = false): Promise<number | null> {
  const socketPath = polishSocketPath();
  let pid: number;
  try {
    pid = (await rpcCall<DaemonInfo>(socketPath, "daemon.ping", {}, 1_000)).pid;
  } catch (error) {
    if (isConnectionError(error)) return null;
    throw error;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  if (!force) {
    throw new Error(`${BRAND.daemon} (pid ${String(pid)}) did not stop within ${String(timeoutMs / 1000)}s: it waits for a model call in flight. Use "${BRAND.cli} daemon stop --force" (runs resume on the next start)`);
  }
  process.kill(pid, "SIGKILL");
  for (const path of [polishLockPath(), polishPidPath(), socketPath]) rmSync(path, { force: true });
  return pid;
}
