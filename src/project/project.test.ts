import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareToBaseline, hasRegression } from "../domain/checks.js";
import { parseTestOutput } from "./parsers.js";
import { buildBaselineSnapshot, detectSilencing } from "./checkRunner.js";
import { discoverProject, ProfileCache } from "./discovery.js";
import { ProjectRegistry } from "./profile.js";

describe("Project discovery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-proj-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" } }, null, 2),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("discovers package manager, checks and manifest hashes from package.json", () => {
    const p = discoverProject(dir, "demo");
    expect(p.alias).toBe("demo");
    expect(p.checks.map((c) => c.name)).toEqual(["test", "lint", "typecheck"]);
    expect(p.manifestHashes["package.json"]).toHaveLength(64);
    expect(p.framework).toBe("vitest");
  });

  it("ProfileCache returns cached profile until manifests change", () => {
    const cache = new ProfileCache();
    const a = cache.get(dir);
    const b = cache.get(dir);
    expect(a).toBe(b);
    writeFileSync(join(dir, "package.json"), readFileSync(join(dir, "package.json"), "utf8") + "\n");
    const c = cache.get(dir);
    expect(c).not.toBe(a);
  });
});

describe("parsers", () => {
  it("parses vitest summary lines", () => {
    const s = parseTestOutput("vitest", " Tests  2 passed | 1 failed\n FAIL  src/a.test.ts", "");
    expect(s).toMatchObject({ total: 3, passed: 2, failed: 1, failingTests: ["src/a.test.ts"] });
  });
});

describe("silencing + baseline", () => {
  let projDir: string;
  beforeEach(() => {
    projDir = mkdtempSync(join(tmpdir(), "polish-base-"));
    writeFileSync(join(projDir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  });
  afterEach(() => {
    rmSync(projDir, { recursive: true, force: true });
  });

  it("detects scripts changes, suppress comments and builds a baseline snapshot", () => {
    const profile = discoverProject(projDir);
    const baseline = buildBaselineSnapshot({
      runId: "run_0000000000000000000000",
      commitHash: "a".repeat(40),
      checks: [{ name: "test", kind: "test", status: "pass", exitCode: 0, durationMs: 1, summary: { total: 10, passed: 10, failed: 0, skipped: 0, failingTests: [] }, outputRef: null }],
      profile,
    });
    const silencing = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: "deadbeef",
      changedFiles: ["src/foo.test.ts"],
      diffText: "+  it.only('x', () => {})\n+ // eslint-disable-next-line",
    });
    expect(silencing.some((s) => s.kind === "scripts_changed")).toBe(true);
    expect(silencing.some((s) => s.kind === "skip_only")).toBe(true);
    expect(silencing.some((s) => s.kind === "suppress_comment")).toBe(true);
    const delta = compareToBaseline(baseline, [{ ...baseline.checks[0]!, summary: null }]);
    expect(hasRegression(delta)).toBe(true);
  });
});

describe("ProjectRegistry", () => {
  it("registers projects by path and alias", () => {
    const reg = new ProjectRegistry();
    reg.register("/tmp/app", "app");
    expect(reg.get("app")?.projectPath).toBe("/tmp/app");
    expect(reg.get("/tmp/app")?.alias).toBe("app");
  });
});
