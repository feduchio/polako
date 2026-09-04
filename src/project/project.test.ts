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
  runChecks,
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

  it("fails independent gates when a failing test is deleted and the count is padded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-silence-gate-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
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
    const dir = mkdtempSync(join(tmpdir(), "polish-skipif-gate-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
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
