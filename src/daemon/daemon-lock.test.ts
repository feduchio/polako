import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolishError } from "../shared/errors.js";
import type { Clock } from "../shared/clock.js";
import { bindDaemon, claimDaemonLock, polishPidPath } from "./main.js";
import { DaemonService, TickWatchdog } from "./service.js";
import { GLOBAL_MODEL_OBSERVATIONS_RUN_ID } from "../domain/event.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daemon lock", () => {
  it("refuses a second claim while the holder's pid is alive", () => {
    const home = freshHome();
    claimDaemonLock(home);
    expect(() => { claimDaemonLock(home); }).toThrow(PolishError);
    try {
      claimDaemonLock(home);
    } catch (error) {
      expect((error as PolishError).message).toContain(String(process.pid));
    }
  });

  it("replaces a lock whose pid is dead", () => {
    const home = freshHome();
    writeFileSync(join(home, "polish.lock"), "2147483646\n");
    claimDaemonLock(home);
    expect(readFileSync(join(home, "polish.lock"), "utf8")).toContain(String(process.pid));
  });

  it("writes the pid only after listen returns", async () => {
    const home = freshHome();
    let pidExistedDuringListen = true;
    await bindDaemon(home, () => {
      pidExistedDuringListen = existsSync(polishPidPath(home));
      return Promise.resolve();
    });
    expect(pidExistedDuringListen).toBe(false);
    expect(readFileSync(polishPidPath(home), "utf8")).toContain(String(process.pid));
  });
});

describe("tick watchdog", () => {
  it("emits once after three over-budget ticks, and a fast tick breaks the run", () => {
    const emitted: number[] = [];
    const watchdog = new TickWatchdog(50, (duration) => { emitted.push(duration); });
    watchdog.observe(2_000);
    watchdog.observe(2_000);
    watchdog.observe(1);
    watchdog.observe(2_000);
    watchdog.observe(2_000);
    expect(emitted).toEqual([]);
    watchdog.observe(2_000);
    watchdog.observe(9_000);
    expect(emitted).toEqual([2_000]);
  });

  it("records one watchdog event when a tick is slowed on purpose", async () => {
    const home = freshHome();
    const clock = new AdvancingClock();
    const service = new DaemonService({ home, clock, tickMs: 50 });
    await service.step();
    await service.step();
    await service.step();
    await service.step();
    const events = service.store.events.list(GLOBAL_MODEL_OBSERVATIONS_RUN_ID, { types: ["daemon.watchdog"] });
    expect(events).toHaveLength(1);
    const ping = await service.handle("daemon.ping", {});
    expect(ping).toMatchObject({ pid: process.pid, home, reportRenders: 0, tickInFlightMs: 0 });
    expect((ping as { lastTickCompletedAt: number }).lastTickCompletedAt).toBeGreaterThan(1_000);
    await service.close();
  });
});

class AdvancingClock implements Clock {
  private t = 0;
  now(): number {
    this.t += 5_000;
    return this.t;
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "polish-daemon-lock-"));
  dirs.push(home);
  return home;
}
