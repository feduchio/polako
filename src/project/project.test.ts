import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptanceArtifact } from "../domain/acceptance.js";
import { compareToBaseline, hasRegression } from "../domain/checks.js";
import type { ProcessResult } from "../sandbox/process.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { id } from "../shared/ids.js";
import { parseTestOutput, statusFromProcess } from "./parsers.js";
import { buildBaselineSnapshot, detectSilencing, runChecks, runIndependentGates } from "./checkRunner.js";
import { discoverProject, ProfileCache } from "./discovery.js";
import { ProjectRegistry } from "./profile.js";

const NOW = 1_700_000_000_000;

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    argv: ["node"],
    cwd: "/tmp/checkout",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    startedAt: NOW,
    ...overrides,
  };
}

function mockSandbox(run: SandboxHandle["run"]): SandboxHandle {
  return {
    id: "sb_1",
    path: "/tmp/checkout",
    branch: null,
    baseCommit: "a".repeat(40),
    git: {} as SandboxHandle["git"],
    run,
    headCommit: async () => "a".repeat(40),
    commitAll: async () => null,
    changedFiles: async () => [],
    diffStat: async () => ({ files: 0, insertions: 0, deletions: 0 }),
    diff: async () => "",
    destroy: async () => undefined,
  };
}

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
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 6\n");
    const p = discoverProject(dir, "demo");
    expect(p.alias).toBe("demo");
    expect(p.packageManager).toBe("pnpm");
    expect(p.checks.map((c) => c.name)).toEqual(["test", "lint", "typecheck"]);
    expect(p.manifestHashes["package.json"]).toHaveLength(64);
    expect(p.manifestHashes["pnpm-lock.yaml"]).toHaveLength(64);
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

  it("ProfileCache invalidates when bun lockfile appears", () => {
    writeFileSync(join(dir, "bun.lock"), "{}");
    const cache = new ProfileCache();
    const a = cache.get(dir)!;
    expect(a.packageManager).toBe("bun");
    writeFileSync(join(dir, "bun.lock"), "{}\n");
    const b = cache.get(dir)!;
    expect(b).not.toBe(a);
    expect(b.packageManager).toBe("bun");
  });
});

describe("parsers", () => {
  it("parses vitest summary lines with passed first", () => {
    const s = parseTestOutput("vitest", " Tests  2 passed | 1 failed\n FAIL  src/a.test.ts", "");
    expect(s).toMatchObject({ total: 3, passed: 2, failed: 1, failingTests: ["src/a.test.ts"] });
  });

  it("parses vitest summary lines with failed first", () => {
    const s = parseTestOutput("vitest", " Tests  1 failed | 2 passed (3)\n FAIL  src/a.test.ts", "");
    expect(s).toMatchObject({ total: 3, passed: 2, failed: 1, failingTests: ["src/a.test.ts"] });
  });

  it("parses jest summary lines", () => {
    const s = parseTestOutput("jest", "Tests: 1 failed, 2 passed, 3 total\n● suite name", "");
    expect(s).toMatchObject({ total: 3, passed: 2, failed: 1, failingTests: ["suite name"] });
  });

  it("maps process outcomes to check status", () => {
    expect(statusFromProcess(false, false, 0)).toBe("pass");
    expect(statusFromProcess(false, false, 1)).toBe("fail");
    expect(statusFromProcess(true, false, null)).toBe("timeout");
    expect(statusFromProcess(false, true, null)).toBe("skipped");
    expect(statusFromProcess(false, false, null)).toBe("error");
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

  it("flags deleted baseline configs and ignores removed suppress lines", () => {
    const profile = discoverProject(projDir);
    const baseline = buildBaselineSnapshot({
      runId: "run_0000000000000000000000",
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    const deleted = detectSilencing({
      baseline,
      candidateConfigHashes: {},
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: [],
      diffText: "- // eslint-disable-next-line no-console\n- it.skip('old', () => {})",
    });
    expect(deleted.some((s) => s.kind === "weakened_config" && s.path === "package.json")).toBe(true);
    expect(deleted.some((s) => s.kind === "suppress_comment")).toBe(false);
    expect(deleted.some((s) => s.kind === "skip_only")).toBe(false);
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

describe("runChecks and runIndependentGates", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("runChecks honors check cwd and maps process results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-run-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const profile = discoverProject(dir);
    profile.checks = [{ name: "test", kind: "test", command: ["node", "-e", "process.exit(0)"], cwd: "pkg", mandatory: true }];
    const run = vi.fn(async (_argv: readonly string[], opts?: { cwd?: string }) => {
      expect(opts?.cwd).toBe("pkg");
      return processResult({ stdout: " Tests  1 passed (1)\n" });
    });
    const results = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(run),
      profile,
    });
    expect(results[0]).toMatchObject({ name: "test", status: "pass", summary: { total: 1, passed: 1, failed: 0 } });
  });

  it("runIndependentGates passes acceptance artifacts to materialize and verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-gate-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const profile = discoverProject(dir);
    profile.checks = [];
    const artifacts: AcceptanceArtifact[] = [{
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath: "tests/gate.test.ts",
      sha256: "b".repeat(64),
      evidenceFor: null,
      createdAt: NOW,
    }];
    const materialize = vi.fn();
    const verify = vi.fn(() => []);
    const run = vi.fn(async () => processResult());
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(run),
      profile,
      acceptanceArtifacts: artifacts,
      materializeAcceptance: materialize,
      verifyAcceptance: verify,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: [],
      diffText: "",
      baseline,
    });
    expect(materialize).toHaveBeenCalledWith("/tmp/checkout", artifacts);
    expect(verify).toHaveBeenCalledWith("/tmp/checkout", artifacts);
    expect(result.passed).toBe(true);
  });
});
