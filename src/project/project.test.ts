import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcceptanceArtifact } from "../domain/acceptance.js";
import type { ProtectedChangeWaiver, ProtectedChangeScope } from "../domain/protectedChangeWaiver.js";
import { compareToBaseline, hasRegression } from "../domain/checks.js";
import type { ProcessResult } from "../sandbox/process.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { defaultConfig } from "../domain/config.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { sha256Hex } from "../shared/hash.js";
import { id } from "../shared/ids.js";
import { parseTestOutput, statusFromProcess } from "./parsers.js";
import { buildBaselineEvidenceView } from "./baselineEvidence.js";
import {
  assessBaselineStability,
  buildBaselineSnapshot,
  detectSilencing,
  ensureProjectDependencies,
  EnvironmentNotReadyError,
  runChecks,
  untrustedChecks,
  runIndependentGates,
  silencingFromDistantWrap,
} from "./checkRunner.js";
import { assertRepositoryClean, checkRepositoryClean, isRepositoryDirty } from "./cleanliness.js";
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

function mockSandbox(
  run: SandboxHandle["run"],
  changedFiles: readonly string[] = [],
  path = "/tmp/checkout",
  diffText = "",
): SandboxHandle {
  return {
    id: "sb_1",
    path,
    branch: null,
    baseCommit: "a".repeat(40),
    git: {} as SandboxHandle["git"],
    run,
    headCommit: async () => "a".repeat(40),
    commitAll: async () => null,
    changedFiles: async () => [...changedFiles],
    diffStat: async () => ({ files: 0, insertions: 0, deletions: 0 }),
    diff: async () => diffText,
    destroy: async () => undefined,
  };
}

function writeAcceptanceFile(dir: string, relativePath: string, content: string): AcceptanceArtifact {
  const dest = join(dir, relativePath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  return {
    id: id("acc"),
    runId: id("run"),
    taskId: null,
    kind: "regression_test",
    relativePath,
    sha256: sha256Hex(content),
    evidenceFor: null,
    createdAt: NOW,
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

  it("reads package.json.packageManager before lockfiles and recognizes node --test", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ packageManager: "npm@10.9.0", scripts: { test: "node --test tests/*.test.mjs" } }, null, 2),
    );
    const p = discoverProject(dir);
    expect(p.packageManager).toBe("npm");
    expect(p.framework).toBe("node-test");
    expect(p.checks[0]?.command).toEqual(["npm", "run", "test"]);
  });

  it("resume-dup-fetch smoke shape is node-test with no lockfile and still has an executable test command", () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/resume-dup-fetch");
    const p = discoverProject(fixture);
    expect(p.framework).toBe("node-test");
    expect(p.packageManager).toBeNull();
    expect(p.checks.some((check) => check.name === "test" && check.mandatory && check.command.length > 0)).toBe(true);
    expect(p.checks[0]?.command).toEqual(["npm", "run", "test"]);
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

  it("parses vitest FAIL titles alongside the file path", () => {
    const s = parseTestOutput(
      "vitest",
      " Tests  1 failed (1)\n FAIL  src/legacy.test.ts > legacy fails\n × src/legacy.test.ts > legacy fails\n",
      "",
    );
    expect(s?.failingTests).toEqual([
      "src/legacy.test.ts",
      "src/legacy.test.ts > legacy fails",
    ]);
    const verbose = parseTestOutput(
      "vitest",
      " Tests  1 failed (1)\n × src/legacy.test.ts > legacy fails 2ms\n",
      "",
    );
    expect(verbose?.failingTests).toEqual([
      "src/legacy.test.ts",
      "src/legacy.test.ts > legacy fails",
    ]);
  });

  it("parses jest summary lines", () => {
    const s = parseTestOutput("jest", "Tests: 1 failed, 2 passed, 3 total\n● suite name", "");
    expect(s).toMatchObject({ total: 3, passed: 2, failed: 1, failingTests: ["suite name"] });
  });

  it("parses resume-dup-fetch TAP node --test output into counts and failing identity", () => {
    const stdout = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/resume-dup-fetch/baseline-test.stdout.txt"), "utf8");
    for (const framework of ["node-test", "unknown"]) {
      const s = parseTestOutput(framework, stdout, "");
      expect(s).toMatchObject({ total: 3, passed: 2, failed: 1, skipped: 0 });
      expect(s?.failingTests.some((name) => name.includes("retries after transient failure and succeeds"))).toBe(true);
      expect(s?.failingTests.some((name) => name.includes("tests/retryFetch.test.mjs"))).toBe(true);
      expect(s?.failingTests.some((name) => name === "RetryFetcher" || name.includes("1 subtest failed"))).toBe(false);
    }
  });

  it("parses resume-dup-fetch spec reporter node --test output into counts and failing identity", () => {
    const stdout = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/resume-dup-fetch/baseline-test.spec.txt"), "utf8");
    const s = parseTestOutput("node-test", stdout, "");
    expect(s).toMatchObject({ total: 3, passed: 2, failed: 1, skipped: 0 });
    expect(s?.failingTests.some((name) => name.includes("retries after transient failure and succeeds"))).toBe(true);
    expect(s?.failingTests.some((name) => name.includes("tests/retryFetch.test.mjs"))).toBe(true);
  });

  it("maps process outcomes to check status", () => {
    expect(statusFromProcess(false, false, 0)).toBe("pass");
    expect(statusFromProcess(false, false, 1)).toBe("fail");
    expect(statusFromProcess(true, false, null)).toBe("timeout");
    expect(statusFromProcess(false, true, null)).toBe("skipped");
    expect(statusFromProcess(false, false, null)).toBe("error");
  });
});

describe("baseline evidence view", () => {
  it("loads compact diagnostics from persisted check_output and omits full TAP stdout", () => {
    const stdout = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/resume-dup-fetch/baseline-test.stdout.txt"), "utf8");
    const forensic = {
      runId: "run_0000000000000000000000",
      commitHash: "ed6b93c3c42143721193b026ba0f7ef709929fd0",
      checkName: "test",
      command: ["npm", "run", "test"],
      status: "fail" as const,
      exitCode: 1,
      stdout,
      stderr: "",
      diagnostics: [
        "    not ok 2 - retries after transient failure and succeeds",
        "      error: 'duplicate in-flight request detected'",
        "# tests 3",
        "# pass 2",
        "# fail 1",
      ],
      truncated: false,
    };
    const sha256 = "2f978b24b034778d852a6cef080ff689153b8e2318635bab6e44b48eec228b62";
    const view = buildBaselineEvidenceView(
      {
        id: "base_0000000000000000000000",
        runId: "run_0000000000000000000000",
        commitHash: "abcdef1",
        checks: [
          {
            name: "test",
            kind: "test",
            status: "fail",
            exitCode: 1,
            durationMs: 174,
            summary: null,
            outputRef: { sha256, kind: "check_output", bytes: stdout.length, label: "ed6b93c3c42143721193b026ba0f7ef709929fd0:test" },
          },
        ],
        configHashes: {},
        scriptsHash: "a".repeat(64),
        toolchain: {},
        createdAt: 1,
      },
      (sha) => (sha === sha256 ? JSON.stringify(forensic) : null),
    );
    expect(view).toHaveLength(1);
    const check = view[0]!;
    expect(check.command).toEqual(["npm", "run", "test"]);
    expect(check.status).toBe("fail");
    expect(check.exitCode).toBe(1);
    expect(check.summary).toMatchObject({ total: 3, passed: 2, failed: 1, skipped: 0 });
    expect(check.summary?.failingTests.some((name) => name.includes("retries after transient failure and succeeds"))).toBe(true);
    expect(check.diagnostics.join("\n")).toContain("duplicate in-flight request detected");
    expect(check.outputArtifact).toEqual({ sha256, kind: "check_output", bytes: stdout.length });
    expect(check).not.toHaveProperty("stdout");
    expect(check).not.toHaveProperty("stderr");
    const encoded = JSON.stringify(check);
    expect(encoded).not.toContain("TAP version 13");
    expect(encoded).not.toContain("node:internal/test_runner");
    expect(encoded.length).toBeLessThan(stdout.length);
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

  it("detects deleted failing tests padded with extra passing tests", () => {
    const profile = discoverProject(projDir);
    const baseline = buildBaselineSnapshot({
      runId: "run_0000000000000000000000",
      commitHash: "a".repeat(40),
      checks: [{
        name: "test",
        kind: "test",
        status: "fail",
        exitCode: 1,
        durationMs: 1,
        summary: { total: 2, passed: 1, failed: 1, skipped: 0, failingTests: ["src/legacy.test.ts"] },
        outputRef: null,
      }],
      profile,
    });
    const silencing = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.test.ts"],
      diffText: [
        "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/legacy.test.ts",
        "-  it('legacy fails', () => { expect(1).toBe(2); });",
        "+  it('pad one', () => { expect(true).toBe(true); });",
        "+  it('pad two', () => { expect(2).toBe(2); });",
      ].join("\n"),
    });
    expect(silencing.some((s) => s.kind === "removed_test" && s.path === "src/legacy.test.ts")).toBe(true);

    const legitimate = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.test.ts"],
      diffText: [
        "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/legacy.test.ts",
        "-    expect(add(1, 1)).toBe(3);",
        "+    expect(add(1, 1)).toBe(2);",
      ].join("\n"),
    });
    expect(legitimate.some((s) => s.kind === "removed_test")).toBe(false);

    const distant = silencingFromDistantWrap(
      baseline,
      [JSON.stringify(["test", "src/legacy.test.ts"])],
      [
        "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/legacy.test.ts",
        "@@ -1,4 +1,5 @@",
        " import { describe, expect, it } from \"vitest\";",
        "+/*",
        " const KEEP_A = [",
        "   0,",
        "@@ -52,3 +53,5 @@ const KEEP_B = [",
        "   23,",
        " ];",
        "+*/",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
      ].join("\n"),
    );
    expect(distant.some((s) => s.kind === "skip_only" && s.path === "src/legacy.test.ts")).toBe(true);

    const assertionFix = silencingFromDistantWrap(
      baseline,
      [JSON.stringify(["test", "src/legacy.test.ts"])],
      [
        "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/legacy.test.ts",
        "-    expect(add(1, 1)).toBe(3);",
        "+    expect(add(1, 1)).toBe(2);",
      ].join("\n"),
    );
    expect(assertionFix).toEqual([]);

    const dummyMinus = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "@@ -1,3 +1,3 @@",
      " it(\"helper\", () => {",
      "-  expect(1).toBe(1);",
      " });",
      "@@ -40,3 +40,5 @@",
      "+/*",
      " const KEEP_B = [",
      "+*/",
      "+it(\"pad\", () => { expect(1).toBe(1); });",
    ].join("\n");
    expect(silencingFromDistantWrap(
      baseline,
      [JSON.stringify(["test", "src/legacy.test.ts"])],
      dummyMinus,
    )).toEqual([]);
    expect(silencingFromDistantWrap(
      baseline,
      [JSON.stringify(["test", "src/legacy.test.ts > legacy fails"])],
      dummyMinus,
    ).some((s) => s.kind === "skip_only" && s.detail.includes("absent from the test-file diff"))).toBe(true);

    for (const decoy of [
      "+// it(\"legacy fails\")",
      "+it(\"legacy fails hidden\", () => { expect(1).toBe(1); });",
      "+describe(\"legacy fails\", () => {});",
    ]) {
      const laundered = [
        "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/legacy.test.ts",
        "@@ -1,3 +1,4 @@",
        " it(\"helper\", () => {",
        "-  expect(1).toBe(1);",
        " });",
        decoy,
        "@@ -40,3 +40,5 @@",
        "+/*",
        " const KEEP_B = [",
        "+*/",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
      ].join("\n");
      expect(
        silencingFromDistantWrap(
          baseline,
          [JSON.stringify(["test", "src/legacy.test.ts > legacy fails"])],
          laundered,
        ).some((s) => s.kind === "skip_only"),
        decoy,
      ).toBe(true);
    }

    const stringDecoy = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "@@ -1,3 +1,3 @@",
      " const HINT = 'documented it(\"legacy fails\") example';",
      " it(\"helper\", () => {",
      "-  expect(1).toBe(1);",
      " });",
      "@@ -40,3 +40,5 @@",
      "+/*",
      " const KEEP_B = [",
      "+*/",
      "+it(\"pad\", () => { expect(1).toBe(1); });",
    ].join("\n");
    expect(silencingFromDistantWrap(
      baseline,
      [JSON.stringify(["test", "src/legacy.test.ts > legacy fails"])],
      stringDecoy,
    ).some((s) => s.kind === "skip_only")).toBe(true);

    const renamed = silencingFromDistantWrap(
      baseline,
      [JSON.stringify(["test", "src/legacy.test.ts > legacy fails"])],
      [
        "diff --git a/src/legacy.test.ts b/src/renamed.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/renamed.test.ts",
        "@@ -1,4 +1,5 @@",
        " import { describe, expect, it } from \"vitest\";",
        "+/*",
        " const KEEP_A = [",
        "@@ -52,3 +53,5 @@",
        " ];",
        "+*/",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
      ].join("\n"),
    );
    expect(renamed.some((s) => s.kind === "skip_only" && s.path === "src/renamed.test.ts")).toBe(true);

    const skipDecoy = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "@@ -1,7 +1,6 @@",
      " it.skip(\"legacy fails\", () => { expect(1).toBe(2); });",
      " it(\"helper\", () => {",
      "-  expect(1).toBe(1);",
      " });",
      "@@ -40,3 +40,5 @@",
      "+/*",
      " const KEEP_B = [",
      "+*/",
      "+it(\"pad\", () => { expect(1).toBe(1); });",
    ].join("\n");
    expect(silencingFromDistantWrap(
      baseline,
      [JSON.stringify(["test", "src/legacy.test.ts > legacy fails"])],
      skipDecoy,
    ).some((s) => s.kind === "skip_only")).toBe(true);

    const renamedAway = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.ts", "src/pad.test.ts"],
      diffText: [
        "diff --git a/src/legacy.test.ts b/src/legacy.ts",
        "similarity index 100%",
        "rename from src/legacy.test.ts",
        "rename to src/legacy.ts",
        "diff --git a/src/pad.test.ts b/src/pad.test.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/pad.test.ts",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
      ].join("\n"),
    });
    expect(renamedAway.some((s) => s.kind === "removed_test_file" && s.path === "src/legacy.test.ts")).toBe(true);

    for (const dest of ["src/renamed.test.ts", "src/legacy.spec.ts", "node_modules/legacy.test.ts"]) {
      const hundred = detectSilencing({
        baseline,
        candidateConfigHashes: baseline.configHashes,
        candidateScriptsHash: baseline.scriptsHash,
        changedFiles: [dest],
        diffText: [
          `diff --git a/src/legacy.test.ts b/${dest}`,
          "similarity index 100%",
          "rename from src/legacy.test.ts",
          `rename to ${dest}`,
        ].join("\n"),
      });
      expect(hundred.some((s) => s.kind === "removed_test_file" && s.path === "src/legacy.test.ts"), dest).toBe(true);
    }

    const padded = compareToBaseline(baseline, [{
      name: "test",
      kind: "test",
      status: "pass",
      exitCode: 0,
      durationMs: 1,
      summary: { total: 2, passed: 2, failed: 0, skipped: 0, failingTests: [] },
      outputRef: null,
    }]);
    expect(padded.newlyPassing).toEqual([JSON.stringify(["test", "src/legacy.test.ts"])]);
    expect(hasRegression(padded)).toBe(false);
  });

  it("detects config exclusion of a failing test file", () => {
    const profile = discoverProject(projDir);
    const baseline = buildBaselineSnapshot({
      runId: "run_0000000000000000000000",
      commitHash: "a".repeat(40),
      checks: [{
        name: "test",
        kind: "test",
        status: "fail",
        exitCode: 1,
        durationMs: 1,
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, failingTests: ["src/legacy.test.ts"] },
        outputRef: null,
      }],
      profile,
    });
    const silencing = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["vitest.config.ts"],
      diffText: [
        "diff --git a/vitest.config.ts b/vitest.config.ts",
        "--- a/vitest.config.ts",
        "+++ b/vitest.config.ts",
        "+export default { test: { exclude: ['src/legacy.test.ts'] } }",
      ].join("\n"),
    });
    expect(silencing.some((s) => s.kind === "weakened_config" && s.path.includes("vitest.config"))).toBe(true);

    const viteIntroduced = detectSilencing({
      baseline,
      candidateConfigHashes: { ...baseline.configHashes, "vite.config.ts": "ab".repeat(32) },
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["vite.config.ts", "src/pad.test.ts"],
      diffText: [
        "diff --git a/vite.config.ts b/vite.config.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/vite.config.ts",
        "+export default { test: { exclude: ['src/legacy.test.ts'] } };",
      ].join("\n"),
    });
    expect(viteIntroduced.some((s) => s.kind === "weakened_config" && s.path === "vite.config.ts")).toBe(true);

    const viteInclude = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: [],
      diffText: [
        "diff --git a/vite.config.ts b/vite.config.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/vite.config.ts",
        "+export default { test: { include: ['src/pad.test.ts'] } };",
      ].join("\n"),
    });
    expect(viteInclude.some((s) => s.kind === "weakened_config" && s.path === "vite.config.ts")).toBe(true);
  });

  it("detects skipIf / xdescribe wraps that hide a baseline failure without reindenting it()", () => {
    const profile = discoverProject(projDir);
    const baseline = buildBaselineSnapshot({
      runId: "run_0000000000000000000000",
      commitHash: "a".repeat(40),
      checks: [{
        name: "test",
        kind: "test",
        status: "fail",
        exitCode: 1,
        durationMs: 1,
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, failingTests: ["src/legacy.test.ts"] },
        outputRef: null,
      }],
      profile,
    });
    const wrapped = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.test.ts"],
      diffText: [
        "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/legacy.test.ts",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
        "+describe.skipIf(true)(\"legacy\", () => {",
        " it(\"legacy fails\", () => { expect(1).toBe(2); });",
        "+});",
      ].join("\n"),
    });
    expect(wrapped.some((s) => s.kind === "skip_only" && s.detail.includes("skipIf"))).toBe(true);

    const xdescribe = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.test.ts"],
      diffText: "+xdescribe('legacy', () => {\n it('legacy fails', () => { expect(1).toBe(2); });\n+});\n",
    });
    expect(xdescribe.some((s) => s.kind === "skip_only")).toBe(true);

    const runIf = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.test.ts"],
      diffText: [
        "+it(\"pad\", () => { expect(1).toBe(1); });",
        "+describe.runIf(false)(\"legacy\", () => {",
        " it(\"legacy fails\", () => { expect(1).toBe(2); });",
        "+});",
      ].join("\n"),
    });
    expect(runIf.some((s) => s.kind === "skip_only" && s.detail.includes("runIf"))).toBe(true);

    const todoOpts = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.test.ts"],
      diffText: [
        "@@ -1,1 +1,3 @@",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
        "+describe(\"legacy\", { todo: true }, () => {",
        " it(\"legacy fails\", () => { expect(1).toBe(2); });",
        "+});",
      ].join("\n"),
    });
    expect(todoOpts.some((s) => s.kind === "skip_only")).toBe(true);

    const ifFalse = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.test.ts"],
      diffText: [
        "@@ -1,1 +1,3 @@",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
        "+if (false) {",
        " it(\"legacy fails\", () => { expect(1).toBe(2); });",
        "+}",
      ].join("\n"),
    });
    expect(ifFalse.some((s) => s.kind === "skip_only")).toBe(true);

    const commentWrap = detectSilencing({
      baseline,
      candidateConfigHashes: baseline.configHashes,
      candidateScriptsHash: baseline.scriptsHash,
      changedFiles: ["src/legacy.test.ts"],
      diffText: [
        "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/legacy.test.ts",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
        "+/*",
        " it(\"legacy fails\", () => { expect(1).toBe(2); });",
        "+*/",
      ].join("\n"),
    });
    expect(commentWrap.some((s) => s.kind === "skip_only")).toBe(true);

    for (const line of [
      "+const mute = describe.skipIf; mute(true)(\"legacy\", () => {",
      "+describe[\"skipIf\"](true)(\"legacy\", () => {",
      "+(0, describe.skipIf)(true)(\"legacy\", () => {",
    ]) {
      const aliased = detectSilencing({
        baseline,
        candidateConfigHashes: baseline.configHashes,
        candidateScriptsHash: baseline.scriptsHash,
        changedFiles: ["src/legacy.test.ts"],
        diffText: `${line}\n it("legacy fails", () => { expect(1).toBe(2); });\n+});\n`,
      });
      expect(aliased.some((s) => s.kind === "skip_only"), line).toBe(true);
    }
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

  /**
   * A checkout whose `vitest run` script can actually resolve its runner. Tests about silencing
   * and comparison want a *trusted* environment: without the binary the check results say nothing
   * about the project, and `runChecks` refuses them before the subject of the test is reached.
   */
  function installedCheckout(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "vitest"), "#!/bin/sh\n");
    return dir;
  }

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

  it("never calls a passing check untrusted, whatever the environment looks like", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-passing-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }));
    const profile = discoverProject(dir);
    const sandbox = mockSandbox(async () => processResult({ stdout: " Tests  1 passed (1)\n" }), [], dir);
    const results = await runChecks({ runId: id("run"), commitHash: "a".repeat(40), sandbox, profile });
    expect(results.find((check) => check.name === "test")?.status).toBe("pass");
    // A check that passed is evidence; refusing a snapshot because of it discards an observation.
    expect(untrustedChecks(sandbox, profile, results)).toEqual([]);
  });

  it("gives a spawn failure in an untrusted environment no fingerprint either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-spawn-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }));
    const profile = discoverProject(dir);
    const refusal = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => {
        throw new Error("failed to spawn pnpm: ENOENT");
      }, [], dir),
      profile,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(EnvironmentNotReadyError);
    const test = (refusal as EnvironmentNotReadyError).checks.find((check) => check.name === "test");
    expect(test?.status).toBe("error");
    expect(test?.failureFingerprint).toBeUndefined();
  });

  it("uses the resolved script, so a check needing packages is untrusted with no declarations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-script-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const profile = discoverProject(dir);
    const refusal = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stderr: "sh: vitest: command not found\n" }), [], dir),
      profile,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(EnvironmentNotReadyError);
    expect((refusal as EnvironmentNotReadyError).untrusted.map((check) => check.name)).toEqual(["test"]);
  });

  describe("ensureProjectDependencies", () => {
    function uninstalled(): string {
      const dir = mkdtempSync(join(tmpdir(), "polish-ensure-"));
      cleanup.push(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      return dir;
    }

    it("attempts nothing when the dependencies are already reachable", async () => {
      const dir = uninstalled();
      mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}');
      const run = vi.fn(async () => processResult({}));
      const result = await ensureProjectDependencies(mockSandbox(run, [], dir), discoverProject(dir), { enabled: true, timeoutMs: 1000 });
      expect(result).toMatchObject({ attempted: false, ready: true });
      expect(run).not.toHaveBeenCalled();
    });

    it("installs and reports ready once the packages appear", async () => {
      const dir = uninstalled();
      const run = vi.fn(async (argv: readonly string[]) => {
        expect(argv).toEqual(["pnpm", "install", "--frozen-lockfile"]);
        mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
        writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}');
        return processResult({ stdout: "done\n" });
      });
      const result = await ensureProjectDependencies(mockSandbox(run, [], dir), discoverProject(dir), { enabled: true, timeoutMs: 1000 });
      expect(result).toMatchObject({ attempted: true, ready: true, detail: null });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("passes the configured timeout and the caller's signal to the command", async () => {
      const dir = uninstalled();
      const controller = new AbortController();
      const seen: { timeoutMs?: number; signal?: AbortSignal }[] = [];
      const run = vi.fn(async (_argv: readonly string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => {
        seen.push({ ...opts });
        return processResult({});
      });
      await ensureProjectDependencies(mockSandbox(run, [], dir), discoverProject(dir), {
        enabled: true,
        timeoutMs: 123_456,
        signal: controller.signal,
      });
      expect(seen[0]?.timeoutMs).toBe(123_456);
      expect(seen[0]?.signal).toBe(controller.signal);
    });

    it("announces the command before running it", async () => {
      const dir = uninstalled();
      const order: string[] = [];
      await ensureProjectDependencies(
        mockSandbox(async () => {
          order.push("ran");
          return processResult({});
        }, [], dir),
        discoverProject(dir),
        { enabled: true, timeoutMs: 1000, onStart: () => order.push("announced") },
      );
      // A crash during a ten-minute install must still leave a record that it was running.
      expect(order).toEqual(["announced", "ran"]);
    });

    it("distinguishes a timeout and an abort from an exit code", async () => {
      const dir = uninstalled();
      const timedOut = await ensureProjectDependencies(
        mockSandbox(async () => processResult({ exitCode: null, timedOut: true }), [], dir),
        discoverProject(dir),
        { enabled: true, timeoutMs: 5000 },
      );
      expect(timedOut.detail).toContain("timed out after 5000ms");
      expect(timedOut.repositorySide).toBeUndefined();

      const aborted = await ensureProjectDependencies(
        mockSandbox(async () => processResult({ exitCode: null, aborted: true }), [], dir),
        discoverProject(dir),
        { enabled: true, timeoutMs: 5000 },
      );
      expect(aborted.detail).toBe("install aborted");
    });

    it("does not blame the repository for a non-zero install, which an exit code cannot tell", async () => {
      const dir = uninstalled();
      const result = await ensureProjectDependencies(
        mockSandbox(async () => processResult({ exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE\n" }), [], dir),
        discoverProject(dir),
        { enabled: true, timeoutMs: 1000 },
      );
      // A stale lockfile and a registry outage look the same from here.
      expect(result.repositorySide).toBeUndefined();
      expect(result.detail).toContain("install exited 1");
    });

    it("does blame the repository when no package manager can be identified", async () => {
      const dir = mkdtempSync(join(tmpdir(), "polish-pm-"));
      cleanup.push(dir);
      // No lockfile, so discovery cannot name a package manager: a repository fact, not an
      // environmental one, and no amount of resuming this run will change it.
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }));
      const profile = discoverProject(dir);
      expect(profile.packageManager).toBeNull();
      const result = await ensureProjectDependencies(mockSandbox(async () => processResult({}), [], dir), profile, {
        enabled: true,
        timeoutMs: 1000,
      });
      expect(result).toMatchObject({ attempted: false, ready: false, repositorySide: true });
    });

    it("does not install when disabled, and says so", async () => {
      const dir = uninstalled();
      const run = vi.fn(async () => processResult({}));
      const result = await ensureProjectDependencies(mockSandbox(run, [], dir), discoverProject(dir), { enabled: false, timeoutMs: 1000 });
      expect(result).toMatchObject({ attempted: false, ready: false, detail: "dependency install is disabled" });
      expect(run).not.toHaveBeenCalled();
    });

    it("reports not ready when the install fails", async () => {
      const dir = uninstalled();
      const result = await ensureProjectDependencies(
        mockSandbox(async () => processResult({ exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE\n" }), [], dir),
        discoverProject(dir),
        { enabled: true, timeoutMs: 1000 },
      );
      expect(result).toMatchObject({ attempted: true, ready: false });
      expect(result.detail).toContain("install exited 1");
      expect(result.output?.stderr).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    });

    it("reports not ready when the install succeeds and changes nothing", async () => {
      const dir = uninstalled();
      const result = await ensureProjectDependencies(
        mockSandbox(async () => processResult({ stdout: "up to date\n" }), [], dir),
        discoverProject(dir),
        { enabled: true, timeoutMs: 1000 },
      );
      expect(result).toMatchObject({ attempted: true, ready: false, detail: "install succeeded but dependencies are still unreachable" });
    });

    function installingSandbox(
      dir: string,
      listings: readonly (string | Error)[],
      exclude?: (paths: readonly string[]) => void,
    ): SandboxHandle {
      const pending = [...listings];
      const out = async () => {
        const next = pending.shift() ?? "";
        if (next instanceof Error) throw next;
        return next;
      };
      const run = async () => {
        mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
        writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}');
        return processResult({});
      };
      return {
        ...mockSandbox(run, [], dir),
        git: { out, ...(exclude === undefined ? {} : { exclude }) } as unknown as SandboxHandle["git"],
      };
    }

    it("excludes only the entries the install added and reports them", async () => {
      const dir = uninstalled();
      const exclude = vi.fn();
      const result = await ensureProjectDependencies(
        installingSandbox(dir, ["notes.txt\n", "notes.txt\nnode_modules/\n"], exclude),
        discoverProject(dir),
        { enabled: true, timeoutMs: 1000 },
      );
      expect(result).toMatchObject({ attempted: true, ready: true, installedPaths: ["node_modules"] });
      expect(exclude).toHaveBeenCalledExactlyOnceWith(["node_modules"]);
    });

    it("records no installed paths when either untracked listing fails", async () => {
      for (const listings of [[new Error("git busy"), "node_modules/\n"], ["", new Error("git busy")]]) {
        const dir = uninstalled();
        const exclude = vi.fn();
        const result = await ensureProjectDependencies(installingSandbox(dir, listings, exclude), discoverProject(dir), {
          enabled: true,
          timeoutMs: 1000,
        });
        expect(result).toMatchObject({ attempted: true, ready: true });
        expect(result.installedPaths).toBeUndefined();
        expect(exclude).not.toHaveBeenCalled();
      }
    });

    it("asks git to exclude nothing when the install added nothing, and tolerates a git handle that cannot exclude", async () => {
      const unchanged = uninstalled();
      const exclude = vi.fn();
      const quiet = await ensureProjectDependencies(
        installingSandbox(unchanged, ["notes.txt\n", "notes.txt\n"], exclude),
        discoverProject(unchanged),
        { enabled: true, timeoutMs: 1000 },
      );
      expect(quiet.installedPaths).toBeUndefined();
      expect(exclude).not.toHaveBeenCalled();

      const noExclude = uninstalled();
      const reported = await ensureProjectDependencies(
        installingSandbox(noExclude, ["", "node_modules/\n"]),
        discoverProject(noExclude),
        { enabled: true, timeoutMs: 1000 },
      );
      expect(reported).toMatchObject({ ready: true, installedPaths: ["node_modules"] });
    });
  });

  it("records a failure in an uninstalled project as error without a fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-untrusted-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }));
    const profile = discoverProject(dir);
    const refusal = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stderr: "sh: vitest: command not found\n" }), [], dir),
      profile,
    }).catch((error: unknown) => error);
    // The refusal is the outer fact: no caller receives this result set at all. Finding 54.
    expect(refusal).toBeInstanceOf(EnvironmentNotReadyError);
    const test = (refusal as EnvironmentNotReadyError).checks.find((check) => check.name === "test");
    // And what it carries is still not a claim about the project. `fail` would be one, and the
    // missing fingerprint is the load-bearing half: it is the handle compareToBaseline uses to
    // call two failures the same one, so nothing downstream can equate this with a real failure.
    expect(test).toMatchObject({ status: "error", exitCode: 1 });
    expect(test?.failureFingerprint).toBeUndefined();
  });

  it("installs once for a sandbox, even when two check runs ask at the same time", async () => {
    // The memo holds the in-flight promise, not the settled result. Holding the result lets two
    // concurrent askers both find nothing cached and both start a ten-minute `npm ci` in the same
    // checkout — two package managers writing one `node_modules`. Finding 54.
    const dir = mkdtempSync(join(tmpdir(), "polish-one-install-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const profile = discoverProject(dir);
    const issued: string[][] = [];
    let releaseInstall: (() => void) | null = null;
    const installStarted = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const sandbox = mockSandbox(async (argv: readonly string[]) => {
      issued.push([...argv]);
      if (argv[1] === "install") {
        releaseInstall?.();
        // Hold the install open so the second caller cannot simply arrive after it finished.
        await new Promise((resolve) => setTimeout(resolve, 10));
        mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
        writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}');
      }
      return processResult({ stdout: " Tests  1 passed (1)\n" });
    }, [], dir);
    const first = runChecks({ runId: id("run"), commitHash: "a".repeat(40), sandbox, profile });
    await installStarted;
    const second = runChecks({ runId: id("run"), commitHash: "a".repeat(40), sandbox, profile });
    await Promise.all([first, second]);
    expect(issued.filter((argv) => argv[1] === "install")).toHaveLength(1);
  });

  it("refuses only on the checks that ran, so `only` does not report an absent one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-only-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      scripts: { test: "vitest run", lint: "vitest --lint" },
      devDependencies: { vitest: "^4" },
    }));
    const profile = discoverProject(dir);
    profile.checks = [
      { name: "test", kind: "test", command: ["pnpm", "run", "test"], mandatory: true },
      { name: "lint", kind: "lint", command: ["pnpm", "run", "lint"], mandatory: true },
    ];
    const refusal = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stderr: "sh: vitest: command not found\n" }), [], dir),
      profile,
      only: ["test"],
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(EnvironmentNotReadyError);
    expect((refusal as EnvironmentNotReadyError).untrusted.map((check) => check.name)).toEqual(["test"]);
  });

  it("prepares by default, so a caller that says nothing still gets an installed sandbox", async () => {
    // Omission means prepare. The wiring at a call site can be deleted without silently turning
    // preparation off, which is how finding 54 kept coming back. Finding 54.
    const dir = mkdtempSync(join(tmpdir(), "polish-default-prepare-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const issued: string[][] = [];
    const results = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async (argv: readonly string[]) => {
        issued.push([...argv]);
        if (argv[1] === "install") {
          mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
          writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}');
        }
        return processResult({ stdout: " Tests  1 passed (1)\n" });
      }, [], dir),
      profile: discoverProject(dir),
    });
    expect(issued[0]).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(results.find((check) => check.name === "test")?.status).toBe("pass");
  });

  it("keeps a genuine failure as fail with a fingerprint once packages are installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-installed-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }));
    mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}');
    const profile = discoverProject(dir);
    const results = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stdout: " Tests  1 failed (1)\n FAIL  src/a.test.ts\n" }), [], dir),
      profile,
    });
    const test = results.find((check) => check.name === "test");
    expect(test?.status).toBe("fail");
    expect(test?.failureFingerprint).toBeTypeOf("string");
  });

  it("persists complete forensic output through an injected callback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-output-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const profile = discoverProject(dir);
    const persisted: unknown[] = [];
    const stdout = ` Tests  1 failed (1)\n FAIL  src/a.test.ts\n${"detail\n".repeat(50)}`;
    const results = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stdout, stderr: "fatal detail" })),
      profile,
      persistOutput: (forensic) => {
        persisted.push(forensic);
        const bytes = Buffer.byteLength(JSON.stringify(forensic));
        return { sha256: sha256Hex(JSON.stringify(forensic)), kind: "check-output", bytes };
      },
    });
    expect(persisted[0]).toMatchObject({ stdout, stderr: "fatal detail", status: "fail" });
    expect(results[0]?.summary).toMatchObject({ total: 1, failed: 1 });
    expect(results[0]?.outputRef?.kind).toBe("check-output");
    expect(results[0]?.failureFingerprint).toHaveLength(64);
  });

  it("runIndependentGates passes acceptance artifacts to materialize and verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-gate-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const profile = discoverProject(dir);
    profile.checks = [];
    const artifacts: AcceptanceArtifact[] = [writeAcceptanceFile(dir, "tests/gate.test.ts", "export const ok = 1;\n")];
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
      sandbox: mockSandbox(run, [], dir),
      profile,
      acceptanceArtifacts: artifacts,
      materializeAcceptance: materialize,
      verifyAcceptance: verify,
      baseline,
    });
    expect(materialize).toHaveBeenCalledWith(dir, artifacts);
    expect(verify).toHaveBeenCalledWith(dir, artifacts);
    expect(result.passed).toBe(true);
  });

  it("rejects no-op materialize/verify callbacks that do not produce canonical bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-gate-noop-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const profile = discoverProject(dir);
    profile.checks = [];
    const artifact: AcceptanceArtifact = {
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath: "tests/gate.test.ts",
      sha256: sha256Hex("canonical regression\n"),
      evidenceFor: null,
      createdAt: NOW,
    };
    const materialize = vi.fn();
    const verify = vi.fn(() => []);
    const baseline = buildBaselineSnapshot({
      runId: artifact.runId,
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(async () => processResult(), [], dir),
      profile,
      acceptanceArtifacts: [artifact],
      materializeAcceptance: materialize,
      verifyAcceptance: verify,
      baseline,
    });
    expect(materialize).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(result.passed).toBe(false);
    expect(result.acceptanceProblems).toEqual([{ path: artifact.relativePath, reason: "missing" }]);
  });

  it("rejects candidate protected-path tampering before materialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-tamper-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const profile = discoverProject(dir);
    profile.checks = [];
    const artifact: AcceptanceArtifact = {
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath: "tests/protected.test.ts",
      sha256: "b".repeat(64),
      evidenceFor: null,
      createdAt: NOW,
    };
    const materialize = vi.fn();
    const verify = vi.fn(() => [{ path: artifact.relativePath, reason: "modified" }]);
    const baseline = buildBaselineSnapshot({
      runId: artifact.runId,
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(async () => processResult(), [artifact.relativePath]),
      profile,
      acceptanceArtifacts: [artifact],
      materializeAcceptance: materialize,
      verifyAcceptance: verify,
      baseline,
    });
    expect(result.passed).toBe(false);
    expect(result.candidateProtectedPathProblems).toEqual([{ path: artifact.relativePath, reason: "modified" }]);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("rejects protected-path tampering through persisted path aliases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-tamper-alias-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const profile = discoverProject(dir);
    profile.checks = [];
    const artifact: AcceptanceArtifact = {
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath: "./tests/fixtures/../protected.test.ts",
      sha256: "b".repeat(64),
      evidenceFor: null,
      createdAt: NOW,
    };
    const materialize = vi.fn();
    const baseline = buildBaselineSnapshot({
      runId: artifact.runId,
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });

    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(async () => processResult(), ["tests/protected.test.ts"]),
      profile,
      acceptanceArtifacts: [artifact],
      materializeAcceptance: materialize,
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });

    expect(result.passed).toBe(false);
    expect(result.candidateProtectedPathProblems).toEqual([
      { path: "tests/protected.test.ts", reason: "modified" },
    ]);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("requires store-backed waiver validation before granting exact scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-waiver-gate-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const profile = discoverProject(dir);
    profile.checks = [];
    const runId = id("run");
    const taskId = id("task");
    const artifact: AcceptanceArtifact = {
      id: id("acc"),
      runId,
      taskId,
      kind: "regression_test",
      relativePath: "tests/protected.test.ts",
      sha256: "b".repeat(64),
      evidenceFor: null,
      createdAt: NOW,
    };
    const waiver: ProtectedChangeWaiver = {
      id: id("waiv"),
      runId,
      missionId: id("msn"),
      taskId,
      requirementId: "R1",
      baseCheckpointHash: "a".repeat(40),
      pathScope: [artifact.relativePath],
      findingKind: "modified",
      justification: "independently validated",
      causeEventId: id("evt"),
      issuedBy: { kind: "supervisor" },
      validatedBy: { kind: "reviewer" },
      createdAt: NOW,
    };
    const scope: Omit<ProtectedChangeScope, "relativePath"> = {
      runId,
      missionId: waiver.missionId,
      taskId: waiver.taskId,
      requirementId: waiver.requirementId,
      baseCheckpointHash: waiver.baseCheckpointHash,
      findingKind: waiver.findingKind,
    };
    const baseline = buildBaselineSnapshot({
      runId,
      commitHash: waiver.baseCheckpointHash,
      checks: [],
      profile,
    });
    const checkout = mkdtempSync(join(tmpdir(), "polish-waiver-co-"));
    cleanup.push(checkout);
    mkdirSync(join(checkout, "tests"), { recursive: true });
    writeFileSync(join(checkout, "package.json"), readFileSync(join(dir, "package.json")));
    writeFileSync(join(checkout, artifact.relativePath), "protected\n");
    const hashed: AcceptanceArtifact = { ...artifact, sha256: sha256Hex("protected\n") };
    let materialized = false;
    const materialize = vi.fn(() => {
      materialized = true;
    });
    const verify = vi.fn(() =>
      materialized ? [] : [{ path: hashed.relativePath, reason: "modified" }]);
    const common = {
      runId,
      commitHash: "b".repeat(40),
      sandbox: mockSandbox(async () => processResult(), [hashed.relativePath], checkout),
      profile,
      acceptanceArtifacts: [hashed],
      materializeAcceptance: materialize,
      verifyAcceptance: verify,
      baseline,
      protectedChangeWaivers: [waiver],
      protectedChangeScope: scope,
    };

    const forged = await runIndependentGates(common);
    expect(forged.passed).toBe(false);
    expect(materialize).not.toHaveBeenCalled();

    const validated = await runIndependentGates({
      ...common,
      validateProtectedChangeWaiver: () => true,
    });
    expect(validated.passed).toBe(true);
    expect(materialize).toHaveBeenCalledOnce();
  });

  it("allows an unchanged baseline failure but rejects a new failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-regression-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    // The comparison under test needs a trustworthy environment: a `vitest run` script with no
    // vitest present is an environment failure, not a project failure (finding 54).
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "vitest"), "#!/bin/sh\n");
    const profile = discoverProject(dir);
    const failingOutput = " Tests  1 failed (1)\n FAIL  src/legacy.test.ts\n";
    const captured = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stdout: failingOutput })),
      profile,
    });
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: "a".repeat(40),
      checks: captured,
      profile,
    });
    const common = {
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    };
    const unchanged = await runIndependentGates({
      ...common,
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stdout: failingOutput }), [], dir),
    });
    expect(unchanged.passed).toBe(true);

    const newFailure = await runIndependentGates({
      ...common,
      sandbox: mockSandbox(async () => processResult({
        exitCode: 1,
        stdout: " Tests  2 failed (2)\n FAIL  src/legacy.test.ts\n FAIL  src/new.test.ts\n",
      }), [], dir),
    });
    expect(newFailure.passed).toBe(false);
    expect(newFailure.regression.newlyFailing).toContain(JSON.stringify(["test", "src/new.test.ts"]));
  });

  it("runs the checks against canonical acceptance bytes even when the install replaced them", async () => {
    // An install runs the project's own lifecycle scripts. Materializing and verifying before it
    // would certify a file the install is still free to replace, and the checks would then run
    // against the replacement. The order is install, materialize, verify, run. Finding 54.
    const dir = mkdtempSync(join(tmpdir(), "polish-install-clobber-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^4" },
    }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(dir, "tests"), { recursive: true });
    const body = "it('protected', () => { expect(1).toBe(1); });\n";
    writeFileSync(join(dir, "tests", "protected.test.ts"), body);
    const artifact: AcceptanceArtifact = {
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath: "tests/protected.test.ts",
      sha256: sha256Hex(body),
      evidenceFor: null,
      createdAt: NOW,
    };
    const profile = discoverProject(dir);
    const baseline = buildBaselineSnapshot({
      runId: artifact.runId,
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    const seenByCheck: string[] = [];
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(async (argv: readonly string[]) => {
        if (argv[1] === "install") {
          mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
          writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}');
          // What a postinstall script can do.
          writeFileSync(join(dir, "tests", "protected.test.ts"), "it.skip('protected', () => {});\n");
        } else {
          seenByCheck.push(readFileSync(join(dir, "tests", "protected.test.ts"), "utf8"));
        }
        return processResult({ stdout: " Tests  1 passed (1)\n" });
      }, [], dir),
      profile,
      acceptanceArtifacts: [artifact],
      // What the store's materializer does: write the canonical bytes from the CAS.
      materializeAcceptance: (checkoutDir, artifacts) => {
        for (const each of artifacts) writeFileSync(join(checkoutDir, each.relativePath), body);
      },
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    // The repair happened, and it happened in time: the command saw the canonical file, not the
    // one the install wrote. Asserting only `passed` would hold for the wrong order too.
    expect(seenByCheck).toEqual([body]);
    expect(result.acceptanceProblems).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("fails the gate when the install replaced an artifact and materialization cannot repair it", async () => {
    // The other half of the same order: verification happens against what is on disk after the
    // install, so a materializer that does not restore the file is caught rather than trusted.
    const dir = mkdtempSync(join(tmpdir(), "polish-install-clobber-unrepaired-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^4" },
    }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(dir, "tests"), { recursive: true });
    const body = "it('protected', () => { expect(1).toBe(1); });\n";
    writeFileSync(join(dir, "tests", "protected.test.ts"), body);
    const artifact: AcceptanceArtifact = {
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath: "tests/protected.test.ts",
      sha256: sha256Hex(body),
      evidenceFor: null,
      createdAt: NOW,
    };
    const profile = discoverProject(dir);
    const baseline = buildBaselineSnapshot({
      runId: artifact.runId,
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    const ran: string[][] = [];
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(async (argv: readonly string[]) => {
        ran.push([...argv]);
        if (argv[1] === "install") {
          mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
          writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}');
          writeFileSync(join(dir, "tests", "protected.test.ts"), "it.skip('protected', () => {});\n");
        }
        return processResult({ stdout: " Tests  1 passed (1)\n" });
      }, [], dir),
      profile,
      acceptanceArtifacts: [artifact],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(result.passed).toBe(false);
    expect(result.acceptanceProblems).toEqual([{ path: artifact.relativePath, reason: "modified" }]);
    // And no check ran against the replacement. The artifacts are what the checks are there to
    // exercise; a result produced against a file we have just called `modified` describes
    // something else, and the gate has already failed without it.
    expect(ran.filter((argv) => argv[1] !== "install")).toEqual([]);
    expect(result.checks).toEqual([]);
  });

  it("rejects a planted untracked protected path before materialization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-untracked-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const profile = discoverProject(dir);
    profile.checks = [];
    const artifact: AcceptanceArtifact = {
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath: "tests/protected.test.ts",
      sha256: "b".repeat(64),
      evidenceFor: null,
      createdAt: NOW,
    };
    const materialize = vi.fn();
    const baseline = buildBaselineSnapshot({
      runId: artifact.runId,
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(async () => processResult(), [artifact.relativePath], dir),
      profile,
      acceptanceArtifacts: [artifact],
      materializeAcceptance: materialize,
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(result.passed).toBe(false);
    expect(result.candidateProtectedPathProblems).toEqual([
      { path: artifact.relativePath, reason: "modified" },
    ]);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("keeps the candidate's own file list, which a staged restore erases from the settled one", async () => {
    // Each capture brings the file list from its own moment. A check that restores a deleted test
    // **and stages it** leaves the settled read with nothing to report, and `removed_test_file`
    // reads the file list rather than the diff — its diff-side neighbour, `removed_test`, only
    // fires on a removed line that declares a test, and this file declares none. So pairing the
    // candidate's diff with the settled list loses the deletion entirely. Finding 54.
    const repoDir = mkdtempSync(join(tmpdir(), "polish-staged-restore-repo-"));
    const wtRoot = mkdtempSync(join(tmpdir(), "polish-staged-restore-wt-"));
    cleanup.push(repoDir, wtRoot);
    const repo = await Git.init(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    const legacy = "throw new Error('legacy is broken');\n";
    writeFileSync(join(repoDir, "src/legacy.test.ts"), legacy);
    const base = (await repo.commitAll("baseline"))!;
    const profile = discoverProject(repoDir);
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: base,
      checks: [{ name: "test", kind: "test", status: "pass", exitCode: 0, durationMs: 1, summary: null, outputRef: null }],
      profile,
    });
    const sandbox = new WorktreeSandbox(repoDir, wtRoot, defaultConfig().sandbox);
    const candidate = await sandbox.create({ id: "staged-cand", baseCommit: base, branch: "polish/staged", policy: CommandPolicy.forProject([], null) });
    rmSync(join(candidate.path, "src/legacy.test.ts"));
    const head = (await candidate.commitAll("drop the broken test"))!;
    const gate = await sandbox.create({ id: "staged-gate", baseCommit: head, policy: CommandPolicy.forProject([], null) });
    const ran: string[][] = [];
    try {
      const result = await runIndependentGates({
        runId: baseline.runId,
        commitHash: head,
        sandbox: {
          ...gate,
          run: async (argv) => {
            ran.push([...argv]);
            mkdirSync(join(gate.path, "src"), { recursive: true });
            writeFileSync(join(gate.path, "src/legacy.test.ts"), legacy);
            execFileSync("git", ["add", "-A"], { cwd: gate.path });
            return processResult({ stdout: " Tests  1 passed (1)\n" });
          },
        },
        profile,
        acceptanceArtifacts: [],
        materializeAcceptance: vi.fn(),
        verifyAcceptance: vi.fn(() => []),
        baseline,
      });
      expect(ran).toEqual([["pnpm", "run", "test"]]);
      expect(result.silencing.some((finding) => finding.kind === "removed_test_file")).toBe(true);
      expect(result.passed).toBe(false);
    } finally {
      await gate.destroy();
      await candidate.destroy();
    }
  });

  it("does not charge the candidate for a manifest the install rewrote", async () => {
    // The settled capture has no hashes, because the baseline's were taken from the project's
    // source and there is nothing at the settled moment to compare them with. An install that
    // rewrites `package.json` does so in the baseline's checkout too, and a candidate that changed
    // nothing must not be accused of changing the scripts block. Finding 54.
    const repoDir = mkdtempSync(join(tmpdir(), "polish-install-manifest-repo-"));
    const wtRoot = mkdtempSync(join(tmpdir(), "polish-install-manifest-wt-"));
    cleanup.push(repoDir, wtRoot);
    const repo = await Git.init(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^4" },
    }));
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/a.test.ts"), "it('a', () => { expect(1).toBe(1); });\n");
    const base = (await repo.commitAll("baseline"))!;
    const profile = discoverProject(repoDir);
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: base,
      checks: [{ name: "test", kind: "test", status: "pass", exitCode: 0, durationMs: 1, summary: null, outputRef: null }],
      profile,
    });
    const sandbox = new WorktreeSandbox(repoDir, wtRoot, defaultConfig().sandbox);
    const gate = await sandbox.create({ id: "install-manifest-gate", baseCommit: base, policy: CommandPolicy.forProject([], null) });
    try {
      const result = await runIndependentGates({
        runId: baseline.runId,
        commitHash: base,
        sandbox: {
          ...gate,
          run: async (argv) => {
            if (argv[1] === "install" || argv[1] === "ci") {
              const vitest = join(gate.path, "node_modules", "vitest");
              mkdirSync(vitest, { recursive: true });
              writeFileSync(join(vitest, "package.json"), '{"name":"vitest"}');
              // A package manager that stamps the manifest — it does this in every checkout,
              // including the one the baseline was taken in.
              writeFileSync(join(gate.path, "package.json"), JSON.stringify({
                scripts: { test: "vitest run" },
                devDependencies: { vitest: "^4" },
                packageManager: "pnpm@9.0.0",
              }));
            }
            return processResult({ stdout: " Tests  1 passed (1)\n" });
          },
        },
        profile,
        acceptanceArtifacts: [],
        materializeAcceptance: vi.fn(),
        verifyAcceptance: vi.fn(() => []),
        baseline,
      });
      expect(result.silencing).toEqual([]);
      expect(result.passed).toBe(true);
    } finally {
      await gate.destroy();
    }
  });

  it("keeps the candidate's own manifest evidence, which a check can undo before anyone looks", async () => {
    // Each capture carries the hashes from its own moment. Reading the manifest only at the end
    // loses whatever the candidate changed and then put back: a script that widens `test`, runs,
    // and restores `package.json` leaves a final hash identical to the baseline's. Finding 54.
    const repoDir = mkdtempSync(join(tmpdir(), "polish-restore-repo-"));
    const wtRoot = mkdtempSync(join(tmpdir(), "polish-restore-wt-"));
    cleanup.push(repoDir, wtRoot);
    const repo = await Git.init(repoDir);
    const original = JSON.stringify({ scripts: { test: "vitest run" } });
    writeFileSync(join(repoDir, "package.json"), original);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/a.test.ts"), "it('a', () => { expect(1).toBe(1); });\n");
    const base = (await repo.commitAll("baseline"))!;
    const profile = discoverProject(repoDir);
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: base,
      checks: [{ name: "test", kind: "test", status: "pass", exitCode: 0, durationMs: 1, summary: null, outputRef: null }],
      profile,
    });
    const sandbox = new WorktreeSandbox(repoDir, wtRoot, defaultConfig().sandbox);
    const candidate = await sandbox.create({ id: "restore-cand", baseCommit: base, branch: "polish/restore", policy: CommandPolicy.forProject([], null) });
    writeFileSync(join(candidate.path, "package.json"), JSON.stringify({ scripts: { test: "vitest run --passWithNoTests" } }));
    const head = (await candidate.commitAll("widen the test script"))!;
    const gate = await sandbox.create({ id: "restore-gate", baseCommit: head, policy: CommandPolicy.forProject([], null) });
    try {
      const result = await runIndependentGates({
        runId: baseline.runId,
        commitHash: head,
        sandbox: {
          ...gate,
          run: async () => {
            // The check puts the manifest back on its way out.
            writeFileSync(join(gate.path, "package.json"), original);
            return processResult({ stdout: " Tests  1 passed (1)\n" });
          },
        },
        profile,
        acceptanceArtifacts: [],
        materializeAcceptance: vi.fn(),
        verifyAcceptance: vi.fn(() => []),
        baseline,
      });
      expect(result.silencing.some((finding) => finding.kind === "scripts_changed")).toBe(true);
      expect(result.passed).toBe(false);
    } finally {
      await gate.destroy();
      await candidate.destroy();
    }
  });

  it("parses each capture on its own, so an earlier deletion cannot cancel a later wrap", async () => {
    // Two reads of one checkout are two states, not one longer diff. The wrap detector reasons per
    // file about additions without a substantial deletion; feeding both states to one parser lets
    // a deletion the candidate made cancel a wrap the install or a check added afterwards, and the
    // silencing disappears. Finding 54.
    const dir = installedCheckout("polish-two-captures-");
    const profile = discoverProject(dir);
    const failingOutput = " Tests  1 failed (1)\n FAIL  src/legacy.test.ts > legacy fails\n";
    const captured = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stdout: failingOutput }), [], dir),
      profile,
    });
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: "a".repeat(40),
      checks: captured,
      profile,
    });
    // What the candidate committed: an unrelated assertion removed, no additions. On its own this
    // is nothing — the wrap detector needs additions, and the hunk has none.
    const candidateDiff = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "-  expect(unrelated).toBe(true);",
      "   it(\"legacy fails\", () => { expect(1).toBe(2); });",
    ].join("\n");
    // What the checkout contains at the verdict: the baseline failure wrapped out of the run by
    // additions alone, with its declaration nowhere in this capture. On its own this is silencing.
    const settledDiff = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "+describe.each([])(\"legacy\", () => {",
      "+});",
    ].join("\n");
    const sandbox: SandboxHandle = {
      ...mockSandbox(async () => processResult({ stdout: " Tests  2 passed (2)\n" }), ["src/legacy.test.ts"], dir),
      git: {
        diffAgainst: async () => candidateDiff,
        trackedDiffAgainst: async () => settledDiff,
      } as unknown as SandboxHandle["git"],
    };
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox,
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(result.silencing.some((finding) => finding.kind === "skip_only")).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("refuses the gate when the settled read of the checkout fails, rather than guessing", async () => {
    // A git object that has the method and throws has failed to answer. Falling back would
    // substitute the commit-range diff, which cannot see a working-tree edit at all — precisely
    // what the second read exists to find. Finding 54.
    const dir = installedCheckout("polish-settled-read-fails-");
    const profile = discoverProject(dir);
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    const sandbox: SandboxHandle = {
      ...mockSandbox(async () => processResult({ stdout: " Tests  1 passed (1)\n" }), [], dir),
      git: {
        diffAgainst: async () => "",
        trackedDiffAgainst: () => Promise.reject(new Error("git index is locked")),
      } as unknown as SandboxHandle["git"],
    };
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox,
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(result.passed).toBe(false);
    expect(result.silencing[0]?.detail).toContain("git index is locked");
  });

  it("fails independent gates when a failing test is deleted and the count is padded", async () => {
    const dir = installedCheckout("polish-silence-gate-");
    const profile = discoverProject(dir);
    const failingOutput = " Tests  1 failed | 1 passed (2)\n FAIL  src/legacy.test.ts\n";
    const captured = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stdout: failingOutput }), [], dir),
      profile,
    });
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: "a".repeat(40),
      checks: captured,
      profile,
    });
    const paddedOutput = " Tests  2 passed (2)\n";
    const silencedDiff = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "-  it('legacy fails', () => { expect(1).toBe(2); });",
      "+  it('pad one', () => { expect(1).toBe(1); });",
      "+  it('pad two', () => { expect(2).toBe(2); });",
    ].join("\n");
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(async () => processResult({ stdout: paddedOutput }), ["src/legacy.test.ts"], dir, silencedDiff),
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(hasRegression(result.regression)).toBe(false);
    expect(result.regression.newlyPassing.length).toBeGreaterThan(0);
    expect(result.silencing.some((s) => s.kind === "removed_test")).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("fails independent gates when skipIf wraps a baseline failure without reindenting it()", async () => {
    const dir = installedCheckout("polish-skipif-gate-");
    const profile = discoverProject(dir);
    const failingOutput = " Tests  1 failed (1)\n FAIL  src/legacy.test.ts > legacy fails\n";
    const captured = await runChecks({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: mockSandbox(async () => processResult({ exitCode: 1, stdout: failingOutput }), [], dir),
      profile,
    });
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: "a".repeat(40),
      checks: captured,
      profile,
    });
    const skipIfDiff = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "+it(\"pad\", () => { expect(1).toBe(1); });",
      "+describe.skipIf(true)(\"legacy\", () => {",
      " it(\"legacy fails\", () => { expect(1).toBe(2); });",
      "+});",
    ].join("\n");
    const result = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(
        async () => processResult({ stdout: " Tests  1 passed | 1 skipped (2)\n" }),
        ["src/legacy.test.ts"],
        dir,
        skipIfDiff,
      ),
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(result.silencing.some((s) => s.kind === "skip_only")).toBe(true);
    expect(result.passed).toBe(false);

    const runIfDiff = skipIfDiff.replace("describe.skipIf(true)", "describe.runIf(false)");
    const runIf = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(
        async () => processResult({ stdout: " Tests  1 passed | 1 skipped (2)\n" }),
        ["src/legacy.test.ts"],
        dir,
        runIfDiff,
      ),
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(runIf.silencing.some((s) => s.kind === "skip_only" && s.detail.includes("runIf"))).toBe(true);
    expect(runIf.passed).toBe(false);

    for (const [label, wrap, close] of [
      ["todo-options", "+describe(\"legacy\", { todo: true }, () => {", "+});"],
      ["if-false", "+if (false) {", "+}"],
      ["if-zero", "+if (0) {", "+}"],
      ["comment-wrap", "+/*", "+*/"],
    ] as const) {
      const wrapDiff = [
        "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
        "--- a/src/legacy.test.ts",
        "+++ b/src/legacy.test.ts",
        "+it(\"pad\", () => { expect(1).toBe(1); });",
        wrap,
        " it(\"legacy fails\", () => { expect(1).toBe(2); });",
        close,
      ].join("\n");
      const wrapped = await runIndependentGates({
        runId: baseline.runId,
        commitHash: baseline.commitHash,
        sandbox: mockSandbox(
          async () => processResult({ stdout: " Tests  1 passed (1)\n" }),
          ["src/legacy.test.ts"],
          dir,
          wrapDiff,
        ),
        profile,
        acceptanceArtifacts: [],
        materializeAcceptance: vi.fn(),
        verifyAcceptance: vi.fn(() => []),
        baseline,
      });
      expect(wrapped.silencing.some((s) => s.kind === "skip_only"), label).toBe(true);
      expect(wrapped.passed, label).toBe(false);
    }

    const distantDiff = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "@@ -1,4 +1,5 @@",
      " import { describe, expect, it } from \"vitest\";",
      "+/*",
      " const KEEP_A = [",
      "   0,",
      "@@ -52,3 +53,5 @@ const KEEP_B = [",
      "   23,",
      " ];",
      "+*/",
      "+it(\"pad\", () => { expect(1).toBe(1); });",
    ].join("\n");
    const distant = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(
        async () => processResult({ stdout: " Tests  1 passed (1)\n" }),
        ["src/legacy.test.ts"],
        dir,
        distantDiff,
      ),
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(distant.silencing.some((s) => s.kind === "skip_only")).toBe(true);
    expect(distant.passed).toBe(false);

    const dummyMinusDiff = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "@@ -1,3 +1,3 @@",
      " it(\"helper\", () => {",
      "-  expect(1).toBe(1);",
      " });",
      "@@ -40,3 +40,5 @@",
      "+/*",
      " const KEEP_B = [",
      "+*/",
      "+it(\"pad\", () => { expect(1).toBe(1); });",
    ].join("\n");
    const dummyMinus = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(
        async () => processResult({ stdout: " Tests  2 passed (2)\n" }),
        ["src/legacy.test.ts"],
        dir,
        dummyMinusDiff,
      ),
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(dummyMinus.silencing.some((s) => s.kind === "skip_only" && s.detail.includes("absent from the test-file diff"))).toBe(true);
    expect(dummyMinus.passed).toBe(false);

    const muteDiff = [
      "diff --git a/src/legacy.test.ts b/src/legacy.test.ts",
      "--- a/src/legacy.test.ts",
      "+++ b/src/legacy.test.ts",
      "+it(\"pad\", () => { expect(1).toBe(1); });",
      "+const mute = describe.skipIf;",
      "+mute(true)(\"legacy\", () => {",
      " it(\"legacy fails\", () => { expect(1).toBe(2); });",
      "+});",
    ].join("\n");
    const muted = await runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: mockSandbox(
        async () => processResult({ stdout: " Tests  1 passed | 1 skipped (2)\n" }),
        ["src/legacy.test.ts"],
        dir,
        muteDiff,
      ),
      profile,
      acceptanceArtifacts: [],
      materializeAcceptance: vi.fn(),
      verifyAcceptance: vi.fn(() => []),
      baseline,
    });
    expect(muted.silencing.some((s) => s.kind === "skip_only")).toBe(true);
    expect(muted.passed).toBe(false);
  });

  it("derives silencing evidence from the checkout, not caller-supplied hashes or diff", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "polish-silence-repo-"));
    const wtRoot = mkdtempSync(join(tmpdir(), "polish-silence-wt-"));
    cleanup.push(repoDir, wtRoot);
    const repo = await Git.init(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({
      scripts: { test: "vitest run", lint: "eslint ." },
    }));
    writeFileSync(join(repoDir, "vitest.config.ts"), "export default { test: {} }\n");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/legacy.test.ts"), "it('legacy fails', () => { expect(1).toBe(2); });\n");
    const base = (await repo.commitAll("baseline"))!;
    const profile = discoverProject(repoDir);
    profile.checks = [];
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: base,
      checks: [{
        name: "test",
        kind: "test",
        status: "fail",
        exitCode: 1,
        durationMs: 1,
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, failingTests: ["src/legacy.test.ts"] },
        outputRef: null,
      }],
      profile,
    });
    const sandbox = new WorktreeSandbox(repoDir, wtRoot, defaultConfig().sandbox);
    const policy = CommandPolicy.forProject([], null);
    const candidate = await sandbox.create({ id: "silence-cand", baseCommit: base, branch: "polish/silence", policy });
    writeFileSync(join(candidate.path, "vitest.config.ts"), "export default { test: { exclude: ['src/legacy.test.ts'] } }\n");
    writeFileSync(join(candidate.path, "src/legacy.test.ts"), "it.skip('legacy fails', () => { expect(1).toBe(2); });\n");
    writeFileSync(join(candidate.path, "package.json"), JSON.stringify({
      scripts: { test: "vitest run --passWithNoTests", lint: "eslint ." },
    }));
    const head = (await candidate.commitAll("silence"))!;
    const gate = await sandbox.create({ id: "silence-gate", baseCommit: head, policy });
    try {
      const result = await runIndependentGates({
        runId: baseline.runId,
        commitHash: head,
        sandbox: gate,
        profile,
        acceptanceArtifacts: [],
        materializeAcceptance: vi.fn(),
        verifyAcceptance: vi.fn(() => []),
        baseline,
      });
      expect(result.silencing.some((s) => s.kind === "weakened_config")).toBe(true);
      expect(result.silencing.some((s) => s.kind === "scripts_changed" || s.kind === "skip_only")).toBe(true);
      expect(result.passed).toBe(false);
    } finally {
      await gate.destroy();
      await candidate.destroy();
    }
  });

  it("does not read an installed node_modules as the candidate's own work", async () => {
    // A repository that does not ignore `node_modules` — which is legal, and which the gate does
    // not get to require — would otherwise hand git's answer straight to the silencing detector:
    // one `it.skip` inside an installed dependency and the candidate is accused of muting a test.
    // The candidate's diff is therefore read before anything is installed into the checkout.
    const repoDir = mkdtempSync(join(tmpdir(), "polish-nodemodules-repo-"));
    const wtRoot = mkdtempSync(join(tmpdir(), "polish-nodemodules-wt-"));
    cleanup.push(repoDir, wtRoot);
    const repo = await Git.init(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^4" },
    }));
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/a.test.ts"), "it('a', () => { expect(1).toBe(1); });\n");
    const base = (await repo.commitAll("baseline"))!;
    const profile = discoverProject(repoDir);
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: base,
      checks: [{ name: "test", kind: "test", status: "pass", exitCode: 0, durationMs: 1, summary: null, outputRef: null }],
      profile,
    });
    const sandbox = new WorktreeSandbox(repoDir, wtRoot, defaultConfig().sandbox);
    const gate = await sandbox.create({ id: "nm-gate", baseCommit: base, policy: CommandPolicy.forProject([], null) });
    try {
      const installed: SandboxHandle = {
        ...gate,
        run: async (argv) => {
          if (argv[1] === "install" || argv[1] === "ci") {
            const dep = join(gate.path, "node_modules", "flaky-dep");
            mkdirSync(dep, { recursive: true });
            writeFileSync(join(dep, "package.json"), '{"name":"flaky-dep"}');
            writeFileSync(join(dep, "index.test.js"), "it.skip('dependency test', () => {});\n");
            const vitest = join(gate.path, "node_modules", "vitest");
            mkdirSync(vitest, { recursive: true });
            writeFileSync(join(vitest, "package.json"), '{"name":"vitest"}');
          }
          return processResult({ stdout: " Tests  1 passed (1)\n" });
        },
      };
      const result = await runIndependentGates({
        runId: baseline.runId,
        commitHash: base,
        sandbox: installed,
        profile,
        acceptanceArtifacts: [],
        materializeAcceptance: vi.fn(),
        verifyAcceptance: vi.fn(() => []),
        baseline,
      });
      expect(result.silencing).toEqual([]);
      expect(result.passed).toBe(true);
    } finally {
      await gate.destroy();
    }
  });

  it("catches a tracked file rewritten by the install or by a check, which no commit shows", async () => {
    // The other side of reading the candidate's diff early: between that read and the verdict, two
    // parties write to the checkout — the install's lifecycle scripts and the check commands. A
    // `vitest.config.ts` exclusion added by either silences tests just as effectively as one the
    // candidate committed, and the early capture cannot see it. Finding 54.
    const repoDir = mkdtempSync(join(tmpdir(), "polish-midrun-repo-"));
    const wtRoot = mkdtempSync(join(tmpdir(), "polish-midrun-wt-"));
    cleanup.push(repoDir, wtRoot);
    const repo = await Git.init(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^4" },
    }));
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(repoDir, "vitest.config.ts"), "export default { test: {} }\n");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src/legacy.test.ts"), "it('legacy', () => { expect(1).toBe(1); });\n");
    const base = (await repo.commitAll("baseline"))!;
    const profile = discoverProject(repoDir);
    const baseline = buildBaselineSnapshot({
      runId: id("run"),
      commitHash: base,
      checks: [{ name: "test", kind: "test", status: "pass", exitCode: 0, durationMs: 1, summary: null, outputRef: null }],
      profile,
    });
    const sandbox = new WorktreeSandbox(repoDir, wtRoot, defaultConfig().sandbox);
    const exclusion = "export default { test: { exclude: ['src/legacy.test.ts'] } }\n";
    const installVitest = (path: string): void => {
      const vitest = join(path, "node_modules", "vitest");
      mkdirSync(vitest, { recursive: true });
      writeFileSync(join(vitest, "package.json"), '{"name":"vitest"}');
    };

    for (const culprit of ["install", "check"] as const) {
      const gate = await sandbox.create({
        id: `midrun-${culprit}`,
        baseCommit: base,
        policy: CommandPolicy.forProject([], null),
      });
      try {
        const result = await runIndependentGates({
          runId: baseline.runId,
          commitHash: base,
          sandbox: {
            ...gate,
            run: async (argv) => {
              const isInstall = argv[1] === "install" || argv[1] === "ci";
              if (isInstall) installVitest(gate.path);
              if (isInstall === (culprit === "install")) {
                writeFileSync(join(gate.path, "vitest.config.ts"), exclusion);
              }
              return processResult({ stdout: " Tests  1 passed (1)\n" });
            },
          },
          profile,
          acceptanceArtifacts: [],
          materializeAcceptance: vi.fn(),
          verifyAcceptance: vi.fn(() => []),
          baseline,
        });
        expect(result.silencing.some((finding) => finding.kind === "weakened_config"), culprit).toBe(true);
        expect(result.passed, culprit).toBe(false);
      } finally {
        await gate.destroy();
      }
    }
  });

  it("bounds confirmation and persists contradictory baseline evidence", async () => {
    const result = (status: "pass" | "fail") => [{
      name: "test",
      kind: "test" as const,
      status,
      exitCode: status === "pass" ? 0 : 1,
      durationMs: 1,
      summary: null,
      outputRef: null,
    }];
    const confirm = vi.fn(async () => result("pass"));
    const persist = vi.fn(() => ({ sha256: "c".repeat(64), kind: "baseline-flakiness", bytes: 1 }));
    const stability = await assessBaselineStability({
      observations: [result("pass"), result("fail")],
      confirm,
      maxConfirmations: 1,
      persistEvidence: persist,
    });
    expect(stability.flaky).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledOnce();
    expect(stability.evidence?.confirmationRuns).toBe(1);

    confirm.mockClear();
    const stable = await assessBaselineStability({ observations: [result("pass"), result("pass")], confirm });
    expect(stable.flaky).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("repository cleanliness", () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires a clean target without mutating dirty files", async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-clean-"));
    const git = await Git.init(dir);
    writeFileSync(join(dir, "tracked.txt"), "base\n");
    await git.commitAll("base");
    expect(checkRepositoryClean(dir)).toEqual({ clean: true, changedPaths: [] });
    writeFileSync(join(dir, "tracked.txt"), "dirty\n");
    expect(() => {
      assertRepositoryClean(dir);
    }).toThrow(/clean tree/);
    expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe("dirty\n");
  });

  it("interprets porcelain output purely and rejects dirty snapshot options in Phase A", () => {
    expect(isRepositoryDirty("")).toBe(false);
    expect(isRepositoryDirty("\n")).toBe(false);
    expect(isRepositoryDirty(" M src/a.ts\n")).toBe(true);
    expect(isRepositoryDirty("?? new file.ts\r\n")).toBe(true);
    expect(() => {
      assertRepositoryClean("/unused", { includeDirty: true });
    }).toThrow(/unsupported in Phase A/);
    expect(() => {
      assertRepositoryClean("/unused", {
        includeDirty: true,
        syntheticSnapshotRef: "refs/polish/snapshots/run_1",
      });
    }).toThrow(/unsupported in Phase A/);
  });
});
