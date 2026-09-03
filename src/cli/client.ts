import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { polishHome, polishSocketPath } from "../daemon/main.js";
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
  throw new Error(`polishd did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function isConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}
