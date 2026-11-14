import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolishConfigSchema } from "../domain/config.js";
import type { NewEvent } from "../domain/event.js";
import type { PhaseContext } from "../engine/types.js";
import { applyProjectGates, discoverProject, splitGateCommand } from "../project/discovery.js";
import { createDiscoveringProjectDriver, projectConfigFor } from "./composition.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "polako-gates-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test", typecheck: "tsc --noEmit", lint: "eslint .", check: "npm run typecheck && npm run lint && npm test" } }));
  return dir;
}

describe("per-project gates", () => {
  it("splits a gate command like a shell would, without interpreting it", () => {
    expect(splitGateCommand("npm run check")).toEqual(["npm", "run", "check"]);
    expect(splitGateCommand('node --import tsx "tools/a b.mjs" --flag')).toEqual(["node", "--import", "tsx", "tools/a b.mjs", "--flag"]);
  });

  it("replaces the guessed checks with the gate, named after the script", () => {
    const dir = project();
    const guessed = discoverProject(dir);
    expect(guessed.checks.map((check) => check.name)).toEqual(["test", "lint", "typecheck"]);
    const gated = applyProjectGates(guessed, ["npm run check"], 1_200_000);
    expect(gated.checks).toEqual([{ name: "check", kind: "test", command: ["npm", "run", "check"], mandatory: true, timeoutMs: 1_200_000 }]);
    expect(applyProjectGates(guessed, ["make verify", "npm run lint"]).checks.map((check) => [check.name, check.command])).toEqual([
      ["gate1", ["make", "verify"]],
      ["lint", ["npm", "run", "lint"]],
    ]);
    // the rest of the profile (test runner, manifests) is untouched
    expect(gated.testRunner).toEqual(guessed.testRunner);
    expect(gated.manifestHashes).toEqual(guessed.manifestHashes);
  });

  it("finds the entry by path, including a ~/ key", () => {
    const config = PolishConfigSchema.parse({ projects: { "/a/b": { gates: ["x"] }, "~/td": { gates: ["npm run check"], gateTimeoutMs: 5_000 } } });
    expect(projectConfigFor(config.projects, "/a/b/")?.gates).toEqual(["x"]);
    expect(projectConfigFor(config.projects, join(homedir(), "td"))?.gateTimeoutMs).toBe(5_000);
    expect(projectConfigFor(config.projects, "/other")).toBeUndefined();
  });

  it("DISCOVERING_PROJECT records the gate as the profile's checks, and only for the configured project", async () => {
    const dir = project();
    const other = project();
    const config = PolishConfigSchema.parse({ projects: { [dir]: { gates: ["npm run check"] } } });
    const driver = createDiscoveringProjectDriver({ config });
    const recorded: NewEvent[] = [];
    const ctxFor = (projectPath: string) => ({
      run: { id: "run_x", projectPath },
      clock: { now: () => 1 },
      store: { events: { list: () => [], append: (events: NewEvent[]) => void recorded.push(...events) } },
    }) as unknown as PhaseContext;
    await driver(ctxFor(dir));
    await driver(ctxFor(other));
    const checks = (event: NewEvent | undefined) => (event?.payload["profile"] as { checks: { name: string }[] }).checks.map((check) => check.name);
    expect(checks(recorded[0])).toEqual(["check"]);
    expect(checks(recorded[1])).toEqual(["test", "lint", "typecheck"]);
  });

  it("is rejected when empty", () => {
    expect(() => PolishConfigSchema.parse({ projects: { "/a": { gates: [] } } })).toThrow();
  });
});
