import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { polishPidPath, polishSocketPath } from "../daemon/main.js";
import { rpcCall } from "../daemon/rpc.js";
import { autostartDaemon } from "./client.js";

let daemonPid: number | null = null;
let home: string | null = null;

afterEach(async () => {
  if (daemonPid !== null) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      // Already stopped.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (home !== null) rmSync(home, { recursive: true, force: true });
  daemonPid = null;
  home = null;
  delete process.env["POLAKO_HOME"];
});

describe("daemon autostart", () => {
  it("leaves a detached daemon, PID file, and socket after the launcher returns", async () => {
    home = mkdtempSync(join(tmpdir(), "polish-daemon-home-"));
    process.env["POLAKO_HOME"] = home;
    await autostartDaemon();
    daemonPid = Number(readFileSync(polishPidPath(home), "utf8").trim());
    expect(existsSync(polishSocketPath(home))).toBe(true);
    expect((await rpcCall<{ pid: number }>(polishSocketPath(home), "daemon.ping", {}, 1_000)).pid).toBe(daemonPid);
    expect(() => process.kill(daemonPid!, 0)).not.toThrow();
  });
});
