import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../sandbox/git.js";
import { DaemonService } from "./service.js";

const dirs: string[] = [];
const services: DaemonService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daemon tick isolation", () => {
  it("advances a new run while another run's phase driver is still working", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-tick-isolation-"));
    dirs.push(dir);
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const repos = await Promise.all(["a", "b"].map(async (name) => {
      const repoDir = join(dir, name);
      mkdirSync(repoDir);
      writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name, scripts: {} }));
      await (await Git.init(repoDir)).commitAll("init");
      return repoDir;
    }));
    const service = new DaemonService({ home, providers: [], tickMs: 5 });
    services.push(service);

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    let slowEntered = false;
    let slowLeft = false;
    service.engine.registerPhase("CREATED", () => Promise.resolve({ status: "complete", nextPhase: "DISCOVERING_PROJECT" }));
    service.engine.registerPhase("DISCOVERING_PROJECT", async (ctx) => {
      if (armed && ctx.run.projectPath.endsWith("/a")) {
        slowEntered = true;
        await held;
        slowLeft = true;
      }
      return { status: "waiting" };
    });

    await service.handle("run", { project: repos[0], mission: "slow" });
    armed = true;
    service.start();
    await until(() => slowEntered);
    const fastRunId = ((await service.handle("run", { project: repos[1], mission: "fast" })) as { id: string }).id;

    await until(() => service.store.repos.runs.get(fastRunId)?.phase === "DISCOVERING_PROJECT");
    expect(slowLeft).toBe(false);
    release();
    await until(() => slowLeft);
  });
});

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
