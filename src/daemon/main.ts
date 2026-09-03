#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

export async function runDaemon(): Promise<void> {
  const home = polishHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(polishPidPath(home), `${process.pid}\n`, { mode: 0o600 });
  const service = new DaemonService({ home });
  const server = new RpcServer(polishSocketPath(home), service);
  await server.listen();
  service.start();

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server.close()
      .then(() => service.close())
      .then(() => {
        rmSync(polishPidPath(home), { force: true });
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
