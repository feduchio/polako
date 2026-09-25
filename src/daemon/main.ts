#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { PolishError } from "../shared/errors.js";
import { isMainModule } from "../shared/cliEntry.js";
import { RpcServer } from "./rpc.js";
import { DaemonService } from "./service.js";

export function polishHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["POLISH_HOME"];
  if (configured === undefined || configured === "") return join(homedir(), ".polish");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

export function polishSocketPath(home = polishHome()): string {
  return process.env["POLISH_SOCKET"] ?? join(home, "polish.sock");
}

export function polishPidPath(home = polishHome()): string {
  return join(home, "polish.pid");
}

export function polishLockPath(home = polishHome()): string {
  return join(home, "polish.lock");
}

/**
 * Exclusive claim, taken before the socket is unlinked. A second process must not delete a live
 * daemon's socket: that is how a ticking process became unreachable for 28 hours.
 */
export function claimDaemonLock(home: string, pid = process.pid): void {
  const lockPath = polishLockPath(home);
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(readFileSync(lockPath, "utf8"));
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
        throw new PolishError("CONFLICT", `polishd is already running as pid ${String(holder)}`);
      }
      rmSync(lockPath, { force: true });
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Listen first, then publish the pid. A pid written earlier can name a process that never listened. */
export async function bindDaemon(home: string, listen: () => Promise<void>): Promise<void> {
  claimDaemonLock(home);
  await listen();
  writeFileSync(polishPidPath(home), `${process.pid}\n`, { mode: 0o600 });
}

export async function runDaemon(): Promise<void> {
  const home = polishHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const service = new DaemonService({ home });
  const server = new RpcServer(polishSocketPath(home), service);
  await bindDaemon(home, () => server.listen());
  service.start();

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server.close()
      .then(() => service.close())
      .then(() => {
        rmSync(polishPidPath(home), { force: true });
        rmSync(polishLockPath(home), { force: true });
        process.exitCode = 0;
      });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (isMainModule(import.meta.url)) {
  runDaemon().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
