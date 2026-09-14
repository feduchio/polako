import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  normalizeAcceptancePath,
  protectedPaths,
  type AcceptanceArtifact,
  type MissionAcceptanceCorpus,
} from "../domain/acceptance.js";
import type { ArtifactRef } from "../domain/common.js";
import {
  compareToBaseline,
  computeFailureFingerprint,
  hasRegression,
  type BaselineFlakiness,
  type BaselineSnapshot,
  type CheckDefinition,
  type CheckResult,
  type RegressionDelta,
} from "../domain/checks.js";
import {
  matchesProtectedChangeWaiver,
  ProtectedChangeWaiverSchema,
  type ProtectedChangeScope,
  type ProtectedChangeWaiver,
} from "../domain/protectedChangeWaiver.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { canonicalJson, sha256Hex } from "../shared/hash.js";
import { id } from "../shared/ids.js";
import { inspectManifestHashes } from "./discovery.js";
import { parseTestOutput, statusFromProcess } from "./parsers.js";
import type { ProjectProfile } from "./profile.js";

export interface CheckRunOptions {
  runId: string;
  commitHash: string;
  sandbox: SandboxHandle;
  profile: ProjectProfile;
  signal?: AbortSignal;
  /** when set, only these checks run */
  only?: readonly string[];
  /** Dependency-injected CAS boundary; project intentionally does not import store. */
  persistOutput?: CheckOutputPersister;
  /** Fired immediately before a check command starts so operators can see in-flight work. */
  onCheckStart?: (info: { name: string; command: readonly string[] }) => void;
}

export interface ForensicCheckOutput {
  runId: string;
  commitHash: string;
  checkName: string;
  command: readonly string[];
  status: CheckResult["status"];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  diagnostics: string[];
  truncated: boolean;
}

export type CheckOutputPersister = (output: ForensicCheckOutput) => ArtifactRef | Promise<ArtifactRef>;

/** Adapter for the repository's content-addressed ArtifactStore without coupling layers. */
export function createCheckOutputPersister(
  artifacts: { put(data: string | Uint8Array, kind: string, label?: string): ArtifactRef },
): CheckOutputPersister {
  return (output) => artifacts.put(canonicalJson(output), "check_output", `${output.commitHash}:${output.checkName}`);
}

export interface BaselineCheckRunOptions extends CheckRunOptions {
  baseline: BaselineSnapshot;
}

export interface CheckRunEvaluation {
  checks: CheckResult[];
  regression: RegressionDelta;
  passed: boolean;
}

/** Run project checks; supplying a baseline also produces the baseline-relative verdict. */
export function runChecks(opts: BaselineCheckRunOptions): Promise<CheckRunEvaluation>;
export function runChecks(opts: CheckRunOptions): Promise<CheckResult[]>;
export async function runChecks(opts: CheckRunOptions | BaselineCheckRunOptions): Promise<CheckResult[] | CheckRunEvaluation> {
  const checks = opts.only ? opts.profile.checks.filter((c) => opts.only?.includes(c.name)) : opts.profile.checks;
  const out: CheckResult[] = [];
  for (const def of checks) {
    out.push(await runOneCheck(opts, def));
  }
  if ("baseline" in opts) {
    const regression = compareToBaseline(opts.baseline, out);
    return { checks: out, regression, passed: !hasRegression(regression) };
  }
  return out;
}

async function runOneCheck(opts: CheckRunOptions, def: CheckDefinition): Promise<CheckResult> {
  const started = Date.now();
  opts.onCheckStart?.({ name: def.name, command: def.command });
  try {
    const runOpts: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {};
    if (def.timeoutMs !== undefined) runOpts.timeoutMs = def.timeoutMs;
    if (opts.signal !== undefined) runOpts.signal = opts.signal;
    if (def.cwd !== undefined) runOpts.cwd = def.cwd;
    const result = await opts.sandbox.run(def.command, runOpts);
    const status = statusFromProcess(result.timedOut, result.aborted, result.exitCode);
    const summary = def.kind === "test" ? parseTestOutput(opts.profile.framework, result.stdout, result.stderr) : null;
    const forensic: ForensicCheckOutput = {
      runId: opts.runId,
      commitHash: opts.commitHash,
      checkName: def.name,
      command: def.command,
      status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      diagnostics: diagnosticLines(result.stdout, result.stderr),
      truncated: result.truncated,
    };
    const outputRef = opts.persistOutput ? await opts.persistOutput(forensic) : null;
    const failureFingerprint =
      status === "pass"
        ? undefined
        : computeFailureFingerprint({
            kind: def.kind,
            status,
            exitCode: result.exitCode,
            summary,
            diagnostics: diagnosticLines(result.stdout, result.stderr),
          });
    return {
      name: def.name,
      kind: def.kind,
      status,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      summary,
      outputRef,
      ...(failureFingerprint === undefined ? {} : { failureFingerprint }),
    };
  } catch (error) {
    const stderr = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const forensic: ForensicCheckOutput = {
      runId: opts.runId,
      commitHash: opts.commitHash,
      checkName: def.name,
      command: def.command,
      status: "error",
      exitCode: null,
      stdout: "",
      stderr,
      diagnostics: [normalizeDiagnostics(stderr)],
      truncated: false,
    };
    let outputRef: ArtifactRef | null = null;
    if (opts.persistOutput) {
      try {
        outputRef = await opts.persistOutput(forensic);
      } catch {
        // The check result must still be returned when forensic persistence itself fails.
      }
    }
    return {
      name: def.name,
      kind: def.kind,
      status: "error",
      exitCode: null,
      durationMs: Date.now() - started,
      summary: null,
      outputRef,
      failureFingerprint: computeFailureFingerprint({
        kind: def.kind,
        status: "error",
        exitCode: null,
        summary: null,
        diagnostics: [normalizeDiagnostics(stderr)],
      }),
    };
  }
}

function normalizeDiagnostics(text: string): string {
  const escape = String.fromCharCode(27);
  return text
    .replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "")
    .replace(/\r\n/g, "\n")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b/gi, "<duration>")
    .trimEnd();
}

function diagnosticLines(stdout: string, stderr: string): string[] {
  const normalized = normalizeDiagnostics(`${stdout}\n${stderr}`);
  const lines = normalized.split("\n").filter((line) => /fail|error|assert|expected|actual/i.test(line));
  return lines.length > 0 ? lines : [normalized];
}

export function buildBaselineSnapshot(input: {
  runId: string;
  commitHash: string;
  checks: readonly CheckResult[];
  profile: ProjectProfile;
  toolchain?: Record<string, string>;
}): BaselineSnapshot {
  return {
    id: id("base"),
    runId: input.runId,
    commitHash: input.commitHash,
    checks: [...input.checks],
    configHashes: { ...input.profile.manifestHashes },
    scriptsHash: input.profile.scriptsHash,
    toolchain: input.toolchain ?? {},
    createdAt: Date.now(),
  };
}

export interface SilencingFinding {
  kind: "skip_only" | "removed_test_file" | "removed_test" | "weakened_config" | "scripts_changed" | "suppress_comment";
  path: string;
  detail: string;
}

/** Compare a candidate diff + configs against baseline artifacts to detect silencing. */
export function detectSilencing(input: {
  baseline: BaselineSnapshot;
  candidateConfigHashes: Record<string, string>;
  candidateScriptsHash: string;
  changedFiles: readonly string[];
  diffText: string;
}): SilencingFinding[] {
  const findings: SilencingFinding[] = [];
  if (input.candidateScriptsHash !== input.baseline.scriptsHash) {
    findings.push({ kind: "scripts_changed", path: "package.json", detail: "scripts block hash changed vs baseline" });
  }
  for (const [path, hash] of Object.entries(input.baseline.configHashes)) {
    const cand = input.candidateConfigHashes[path];
    if (cand === undefined) {
      findings.push({ kind: "weakened_config", path, detail: "config file removed vs baseline" });
    } else if (cand !== hash) {
      findings.push({ kind: "weakened_config", path, detail: "config file hash changed vs baseline" });
    }
  }
  for (const path of Object.keys(input.candidateConfigHashes)) {
    if (isTestConfigPath(path) && input.baseline.configHashes[path] === undefined) {
      findings.push({ kind: "weakened_config", path, detail: "test config introduced vs baseline" });
    }
  }
  const baselineFailingNames = baselineFailingIdentities(input.baseline);
  let currentPath = "diff";
  let hunkHasPlus = false;
  let hunkRemovedFailure = false;
  const hunkContextFailures: string[] = [];
  const flushHunk = (): void => {
    if (hunkHasPlus && !hunkRemovedFailure) {
      for (const detail of hunkContextFailures) {
        findings.push({
          kind: "skip_only",
          path: currentPath,
          detail: `baseline failing test left unmodified while wrapping: ${detail}`,
        });
      }
    }
    hunkHasPlus = false;
    hunkRemovedFailure = false;
    hunkContextFailures.length = 0;
  };
  for (const line of input.diffText.split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git?.[1] && git[2]) {
      flushHunk();
      currentPath = git[2];
      if (git[1] !== git[2] && TEST_FILE.test(git[1])) {
        findings.push({
          kind: "removed_test_file",
          path: git[1],
          detail: "test file renamed",
        });
      }
      if (isTestConfigPath(git[2]) && input.baseline.configHashes[git[2]] === undefined) {
        findings.push({
          kind: "weakened_config",
          path: git[2],
          detail: "test config introduced or untracked vs baseline",
        });
      }
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      continue;
    }
    const plusFile = /^\+\+\+ [ab]\/(.+)$/.exec(line);
    if (plusFile?.[1]) {
      currentPath = plusFile[1];
      continue;
    }
    const minusFile = /^--- [ab]\/(.+)$/.exec(line);
    if (minusFile?.[1]) {
      currentPath = minusFile[1];
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunkHasPlus = true;
      if (isSkipOrOnlyLine(line)) {
        findings.push({ kind: "skip_only", path: currentPath, detail: line.trim() });
      }
      if (/@ts-ignore|eslint-disable/.test(line)) {
        findings.push({ kind: "suppress_comment", path: currentPath, detail: line.trim() });
      }
      if (isTestExclusionLine(line) && (isTestConfigPath(currentPath) || mentionsTestPath(line))) {
        findings.push({ kind: "weakened_config", path: currentPath, detail: line.trim() });
      }
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      if (isTestDeclarationLine(line) && pathTouchesBaselineFailure(currentPath, line, baselineFailingNames)) {
        hunkRemovedFailure = true;
        findings.push({ kind: "removed_test", path: currentPath, detail: line.trim() });
      }
      continue;
    }
    if (isTestDeclarationLine(line) && pathTouchesBaselineFailure(currentPath, line, baselineFailingNames)) {
      hunkContextFailures.push(line.trim());
    }
  }
  flushHunk();
  const baseTests = new Set(input.baseline.checks.filter((c) => c.kind === "test").map((c) => c.name));
  for (const f of input.changedFiles) {
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && input.diffText.includes(`deleted file mode`) && input.diffText.includes(f)) {
      findings.push({ kind: "removed_test_file", path: f, detail: "test file removed in candidate diff" });
    }
    if (isTestConfigPath(f) && input.baseline.configHashes[f] === undefined) {
      findings.push({
        kind: "weakened_config",
        path: f,
        detail: "test config introduced or untracked vs baseline",
      });
    }
  }
  if (baseTests.size === 0 && input.changedFiles.some((f) => f.includes("vitest.config"))) {
    findings.push({ kind: "weakened_config", path: "vitest.config", detail: "test config touched" });
  }
  return findings;
}

const TEST_DECLARATION = /\b(?:it|test|describe|suite)(?:\.(?:only|skip|todo|each|failing|skipIf|onlyIf|runIf|fixme))?\s*\(/;
const TEST_SKIP_OR_ONLY = /\.(?:only|skip|todo|fixme)(?:If)?\b|\.runIf\b|\["(?:only|skip|todo|fixme|skipIf|onlyIf|runIf)"\]|\['(?:only|skip|todo|fixme|skipIf|onlyIf|runIf)'\]|\{\s*(?:todo|skip)\s*:\s*true\b|\bif\s*\(\s*(?:false|0)\s*\)|\b(?:xit|xtest|xdescribe)\b/;
const TEST_EXCLUSION = /\b(?:exclude|include|testNamePattern|testPathIgnorePatterns|coveragePathIgnorePatterns|testIgnore|ignorePattern|testDir)\b|\bdir\s*:/;
const TEST_CONFIG = /(?:^|\/)(?:vitest|jest|vite)\.config\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function isTestDeclarationLine(line: string): boolean {
  return TEST_DECLARATION.test(line);
}

function isSkipOrOnlyLine(line: string): boolean {
  return TEST_SKIP_OR_ONLY.test(line);
}

/** A baseline failure that disappears while skipped count rises is a skip, not a fix. */
export function silencingFromSkippedBaselineFailures(
  baseline: BaselineSnapshot,
  candidate: readonly CheckResult[],
  newlyPassing: readonly string[],
): SilencingFinding[] {
  if (newlyPassing.length === 0) return [];
  const candByName = new Map(candidate.map((check) => [check.name, check] as const));
  const findings: SilencingFinding[] = [];
  const seen = new Set<string>();
  for (const key of newlyPassing) {
    const identity = parseNewlyPassingKey(key);
    if (identity === null) continue;
    const { checkName, testName } = identity;
    const base = baseline.checks.find((check) => check.name === checkName);
    const cand = candByName.get(checkName);
    if (base === undefined || cand === undefined) continue;
    const baseSkipped = base.summary?.skipped ?? 0;
    const candSkipped = cand.summary?.skipped ?? 0;
    if (candSkipped <= baseSkipped) continue;
    const path = normalizeChangedPath(testName);
    if (seen.has(path)) continue;
    seen.add(path);
    findings.push({
      kind: "skip_only",
      path,
      detail: `baseline failure ${testName} newly passing while skipped count increased (${baseSkipped} → ${candSkipped})`,
    });
  }
  return findings;
}

/**
 * Split-hunk wrap/elision: the failing `it()` is omitted from the unified diff
 * because wrappers sit at file edges around unchanged padding. Token and
 * same-hunk detectors never see that line. A baseline failure that newly
 * passes while its test file gained lines and had no substantial test-body
 * deletion is treated as silencing.
 */
export function silencingFromDistantWrap(
  baseline: BaselineSnapshot,
  newlyPassing: readonly string[],
  diffText: string,
): SilencingFinding[] {
  if (newlyPassing.length === 0 || diffText.trim() === "") return [];
  const { files, aliases } = inspectTestFilePlusMinus(diffText);
  const findings: SilencingFinding[] = [];
  const seen = new Set<string>();
  for (const key of newlyPassing) {
    const identity = parseNewlyPassingKey(key);
    if (identity === null) continue;
    const path = resolveNewlyPassingTestFile(identity.testName, files, aliases);
    if (path === null) continue;
    const info = files.get(path);
    if (!info?.hasPlus) continue;
    const title = titleOfIdentity(identity.testName);
    const titleAbsent = title !== null && !diffMentionsTitleAsDeclaration(diffText, path, title);
    if (!titleAbsent && info.hasSubstantialMinus) continue;
    const seenKey = titleAbsent ? `${path}::${title}` : path;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    findings.push({
      kind: "skip_only",
      path,
      detail: titleAbsent
        ? `baseline failure ${identity.testName} newly passing while its declaration is absent from the test-file diff`
        : `baseline failure ${identity.testName} newly passing while ${path} was edited with additions only`,
    });
  }
  return findings;
}

interface TestFilePlusMinus {
  hasPlus: boolean;
  hasSubstantialMinus: boolean;
}

function inspectTestFilePlusMinus(diffText: string): {
  files: Map<string, TestFilePlusMinus>;
  aliases: Map<string, string>;
} {
  const files = new Map<string, TestFilePlusMinus>();
  const aliases = new Map<string, string>();
  let currentPath = "diff";
  const ensure = (): TestFilePlusMinus => {
    const existing = files.get(currentPath);
    if (existing) return existing;
    const created: TestFilePlusMinus = { hasPlus: false, hasSubstantialMinus: false };
    files.set(currentPath, created);
    return created;
  };
  for (const line of diffText.split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git?.[1] && git[2]) {
      currentPath = git[2];
      if (git[1] !== git[2]) aliases.set(git[1], git[2]);
      continue;
    }
    const plusFile = /^\+\+\+ [ab]\/(.+)$/.exec(line);
    if (plusFile?.[1]) {
      currentPath = plusFile[1];
      continue;
    }
    const minusFile = /^--- [ab]\/(.+)$/.exec(line);
    if (minusFile?.[1]) {
      currentPath = minusFile[1];
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      ensure().hasPlus = true;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---") && isSubstantialTestEditLine(line)) {
      ensure().hasSubstantialMinus = true;
    }
  }
  return { files, aliases };
}

function isSubstantialTestEditLine(line: string): boolean {
  const body = line.startsWith("-") ? line.slice(1) : line;
  if (body.trim() === "") return false;
  return isTestDeclarationLine(body) ||
    /\b(?:expect|assert(?:Equals|True|False)?|toBe|toEqual|toThrow|toHaveBeenCalled)\b/.test(body);
}

function resolveNewlyPassingTestFile(
  testName: string,
  files: Map<string, TestFilePlusMinus>,
  aliases: Map<string, string>,
): string | null {
  const filePart = filePartOfIdentity(testName);
  const mapped = aliases.get(filePart) ??
    [...aliases.entries()].find(([from]) =>
      filePart.endsWith(`/${from}`) || from.endsWith(`/${filePart}`) || filePart === from
    )?.[1] ??
    filePart;
  if (files.has(mapped)) return mapped;
  for (const path of files.keys()) {
    if (path === mapped || path.endsWith(`/${mapped}`) || mapped.endsWith(`/${path}`)) return path;
  }
  const base = mapped.split("/").pop();
  if (base && TEST_FILE.test(base)) {
    for (const path of files.keys()) {
      if (path === base || path.endsWith(`/${base}`)) return path;
    }
  }
  return TEST_FILE.test(mapped) ? mapped : null;
}

function filePartOfIdentity(testName: string): string {
  const viaColon = testName.split("::")[0] ?? testName;
  const viaGt = viaColon.split(" > ")[0] ?? viaColon;
  return normalizeChangedPath(viaGt.trim());
}

function titleOfIdentity(testName: string): string | null {
  const gt = testName.indexOf(" > ");
  if (gt !== -1) {
    const rest = testName.slice(gt + 3).trim();
    const parts = rest.split(" > ");
    return parts[parts.length - 1] ?? rest;
  }
  const col = testName.indexOf("::");
  if (col !== -1) return testName.slice(col + 2).trim();
  return null;
}

function diffMentionsTitleAsDeclaration(diffText: string, path: string, title: string): boolean {
  let currentPath = "diff";
  for (const line of diffText.split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git?.[2]) {
      currentPath = git[2];
      continue;
    }
    const plusFile = /^\+\+\+ [ab]\/(.+)$/.exec(line);
    if (plusFile?.[1]) {
      currentPath = plusFile[1];
      continue;
    }
    const minusFile = /^--- [ab]\/(.+)$/.exec(line);
    if (minusFile?.[1]) {
      currentPath = minusFile[1];
      continue;
    }
    if (currentPath !== path && !currentPath.endsWith(`/${path}`) && !path.endsWith(`/${currentPath}`)) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    const raw = line.startsWith("-") ? line.slice(1) : line;
    const body = raw.replace(/\/\/.*$/, "");
    if (declarationHasExactTitle(body, title)) return true;
  }
  return false;
}

function declarationHasExactTitle(body: string, title: string): boolean {
  const trimmed = body.trim();
  if (!/^(?:it|test|describe|suite)\b/.test(trimmed) || !isTestDeclarationLine(trimmed)) return false;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    String.raw`^(?:it|test|describe|suite)\s*\(\s*(["'\`])${escaped}\1`,
  ).test(trimmed);
}

function parseNewlyPassingKey(key: string): { checkName: string; testName: string } | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    const checkName: unknown = parsed[0];
    const testName: unknown = parsed[1];
    if (typeof checkName !== "string" || typeof testName !== "string") return null;
    return { checkName, testName };
  } catch {
    return null;
  }
}

function isTestExclusionLine(line: string): boolean {
  return TEST_EXCLUSION.test(line);
}

function isTestConfigPath(path: string): boolean {
  return TEST_CONFIG.test(path);
}

function mentionsTestPath(line: string): boolean {
  return TEST_FILE.test(line) || /\.(?:test|spec)\.[cm]?[jt]sx?\b/.test(line);
}

function baselineFailingIdentities(baseline: BaselineSnapshot): Set<string> {
  const names = new Set<string>();
  for (const check of baseline.checks) {
    for (const testName of check.summary?.failingTests ?? []) {
      names.add(testName);
      const filePart = filePartOfIdentity(testName);
      if (filePart) names.add(filePart);
    }
  }
  return names;
}

function pathTouchesBaselineFailure(path: string, removedLine: string, failing: Set<string>): boolean {
  if (failing.size === 0) return false;
  if (failing.has(path)) return true;
  for (const name of failing) {
    if (removedLine.includes(name) || path.endsWith(name) || name.endsWith(path)) return true;
    const base = path.split("/").pop();
    if (base && (name === base || name.endsWith(`/${base}`))) return true;
  }
  return false;
}

export interface GateResult {
  checks: CheckResult[];
  silencing: SilencingFinding[];
  acceptanceProblems: { path: string; reason: string }[];
  candidateProtectedPathProblems: { path: string; reason: string }[];
  regression: RegressionDelta;
  passed: boolean;
}

/**
 * Independent gates: run on a clean checkout with acceptance artifacts materialized from CAS.
 * The candidate's worktree is not trusted until this passes.
 */
export async function runIndependentGates(input: {
  runId: string;
  commitHash: string;
  sandbox: SandboxHandle;
  profile: ProjectProfile;
  acceptanceArtifacts: readonly AcceptanceArtifact[];
  acceptanceCorpus?: MissionAcceptanceCorpus;
  verifyAcceptance: (
    checkoutDir: string,
    artifacts: readonly AcceptanceArtifact[],
    corpus?: MissionAcceptanceCorpus,
  ) => { path: string; reason: string }[];
  materializeAcceptance: (
    checkoutDir: string,
    artifacts: readonly AcceptanceArtifact[],
    corpus?: MissionAcceptanceCorpus,
  ) => void;
  baseline: BaselineSnapshot;
  signal?: AbortSignal;
  persistOutput?: CheckOutputPersister;
  onCheckStart?: (info: { name: string; command: readonly string[] }) => void;
  protectedChangeWaivers?: readonly ProtectedChangeWaiver[];
  protectedChangeScope?: Omit<ProtectedChangeScope, "relativePath">;
  /** Store-backed authority check; schema-valid waiver objects alone are never trusted. */
  validateProtectedChangeWaiver?: (waiver: ProtectedChangeWaiver) => boolean;
}): Promise<GateResult> {
  const protectedSet = protectedPaths(input.acceptanceArtifacts);
  let actualChangedFiles: string[];
  try {
    actualChangedFiles = (await input.sandbox.changedFiles(input.baseline.commitHash)).map(normalizeChangedPath);
  } catch (error) {
    const reason = `candidate protected-path inspection failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      checks: [],
      silencing: [],
      acceptanceProblems: [],
      candidateProtectedPathProblems: [{ path: "<candidate-checkout>", reason }],
      regression: compareToBaseline(input.baseline, []),
      passed: false,
    };
  }
  const changedProtectedPaths = [...new Set(
    actualChangedFiles.filter((path) => protectedSet.has(path)),
  )].sort();
  const changedArtifacts = input.acceptanceArtifacts.filter((artifact) =>
    changedProtectedPaths.includes(normalizeChangedPath(artifact.relativePath)));
  const candidateProtectedPathProblems = (() => {
    if (changedArtifacts.length === 0) return [];
    const byPath = new Map<string, { path: string; reason: string }>();
    for (const problem of inspectCanonicalAcceptance(input.sandbox.path, changedArtifacts)) {
      byPath.set(normalizeChangedPath(problem.path), {
        path: normalizeChangedPath(problem.path),
        reason: "modified",
      });
    }
    // Keep callback diagnostics when both inspectors reject the same path, but never let an
    // empty/forged callback erase the independent canonical result.
    for (const problem of inspectProtectedPaths(
      input.sandbox.path,
      changedArtifacts,
      input.verifyAcceptance,
    )) {
      byPath.set(normalizeChangedPath(problem.path), {
        path: normalizeChangedPath(problem.path),
        reason: problem.reason,
      });
    }
    return [...byPath.values()];
  })()
    .filter((problem) => !hasMatchingProtectedChangeWaiver(
      normalizeChangedPath(problem.path),
      input.protectedChangeWaivers,
      input.protectedChangeScope,
      input.validateProtectedChangeWaiver,
    ));
  if (candidateProtectedPathProblems.length > 0) {
    return {
      checks: [],
      silencing: [],
      acceptanceProblems: [],
      candidateProtectedPathProblems,
      regression: compareToBaseline(input.baseline, []),
      passed: false,
    };
  }

  const acceptanceProblems: { path: string; reason: string }[] = (() => {
    try {
      input.materializeAcceptance(input.sandbox.path, input.acceptanceArtifacts);
      const callbackProblems = inspectProtectedPaths(
        input.sandbox.path,
        input.acceptanceArtifacts,
        input.verifyAcceptance,
      );
      // Callback success cannot forge canonical presence; inspect checkout bytes/hash.
      return mergeAcceptanceProblems(
        inspectCanonicalAcceptance(input.sandbox.path, input.acceptanceArtifacts),
        callbackProblems,
      );
    } catch (error) {
      return [{
        path: "<acceptance-materialization>",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  })();
  const checkOpts: BaselineCheckRunOptions = {
    runId: input.runId,
    commitHash: input.commitHash,
    sandbox: input.sandbox,
    profile: input.profile,
    baseline: input.baseline,
  };
  if (input.signal !== undefined) checkOpts.signal = input.signal;
  if (input.persistOutput !== undefined) checkOpts.persistOutput = input.persistOutput;
  if (input.onCheckStart !== undefined) checkOpts.onCheckStart = input.onCheckStart;
  const evaluation = await runChecks(checkOpts);
  const checks = evaluation.checks;
  const waivedSilencingPaths = new Set(
    actualChangedFiles
      .map(normalizeChangedPath)
      .filter((path) => hasMatchingProtectedChangeWaiver(
        path,
        input.protectedChangeWaivers,
        input.protectedChangeScope,
        input.validateProtectedChangeWaiver,
      )),
  );
  let actualDiffText: string;
  let actualConfigHashes: Record<string, string>;
  let actualScriptsHash: string;
  try {
    actualDiffText = await inspectCandidateDiff(input.sandbox, input.baseline.commitHash);
    const hashes = inspectManifestHashes(input.sandbox.path);
    actualConfigHashes = hashes.manifestHashes;
    actualScriptsHash = hashes.scriptsHash;
  } catch (error) {
    const reason = `candidate silencing inspection failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      checks,
      silencing: [{ kind: "weakened_config", path: "<candidate-checkout>", detail: reason }],
      acceptanceProblems,
      candidateProtectedPathProblems,
      regression: evaluation.regression,
      passed: false,
    };
  }
  const silencing = [
    ...detectSilencing({
      baseline: input.baseline,
      candidateConfigHashes: actualConfigHashes,
      candidateScriptsHash: actualScriptsHash,
      changedFiles: actualChangedFiles,
      diffText: actualDiffText,
    }),
    ...silencingFromSkippedBaselineFailures(input.baseline, checks, evaluation.regression.newlyPassing),
    ...silencingFromDistantWrap(input.baseline, evaluation.regression.newlyPassing, actualDiffText),
  ].filter((finding) => !waivedSilencingPaths.has(normalizeChangedPath(finding.path)));
  const regression = evaluation.regression;
  const passed = evaluation.passed && acceptanceProblems.length === 0 && silencing.length === 0;
  return { checks, silencing, acceptanceProblems, candidateProtectedPathProblems, regression, passed };
}

/**
 * Independently confirm each acceptance artifact exists as a regular file inside the
 * checkout and that its bytes match `AcceptanceArtifact.sha256`. A verify callback
 * that returns success cannot forge this.
 */
export function inspectCanonicalAcceptance(
  checkoutDir: string,
  artifacts: readonly AcceptanceArtifact[],
): { path: string; reason: string }[] {
  if (artifacts.length === 0) return [];
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(checkoutDir));
  } catch (error) {
    const reason = `checkout is not readable: ${error instanceof Error ? error.message : String(error)}`;
    return artifacts.map((artifact) => ({
      path: normalizeChangedPath(artifact.relativePath),
      reason,
    }));
  }
  const problems: { path: string; reason: string }[] = [];
  for (const artifact of artifacts) {
    const path = normalizeChangedPath(artifact.relativePath);
    try {
      const target = resolveAcceptanceTarget(rootReal, path);
      const st = existsSync(target) ? lstatSync(target) : null;
      if (!st) {
        problems.push({ path, reason: "missing" });
        continue;
      }
      if (!st.isFile() || !fileResolvesInside(rootReal, target)) {
        problems.push({ path, reason: "not_a_file" });
        continue;
      }
      if (sha256Hex(readFileSync(target)) !== artifact.sha256) {
        problems.push({ path, reason: "modified" });
      }
    } catch (error) {
      problems.push({
        path,
        reason: error instanceof Error ? error.message : "missing",
      });
    }
  }
  return problems;
}

async function inspectCandidateDiff(sandbox: SandboxHandle, base: string): Promise<string> {
  if (typeof sandbox.git.diffAgainst === "function") {
    try {
      return await sandbox.git.diffAgainst(base);
    } catch {
      // Stub git objects in tests fall through to sandbox.diff().
    }
  }
  return sandbox.diff();
}

function resolveAcceptanceTarget(rootReal: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("acceptance artifact path must be a non-empty relative path");
  }
  const target = resolve(rootReal, relativePath);
  const rel = relative(rootReal, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("acceptance artifact path escapes checkout");
  }
  return target;
}

function fileResolvesInside(rootReal: string, target: string): boolean {
  try {
    const fileReal = realpathSync(target);
    return fileReal === rootReal || fileReal.startsWith(rootReal + sep);
  } catch {
    return false;
  }
}

function mergeAcceptanceProblems(
  independent: readonly { path: string; reason: string }[],
  callback: readonly { path: string; reason: string }[],
): { path: string; reason: string }[] {
  const seen = new Set<string>();
  const out: { path: string; reason: string }[] = [];
  for (const problem of [...independent, ...callback]) {
    const key = `${normalizeChangedPath(problem.path)}\0${problem.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: normalizeChangedPath(problem.path), reason: problem.reason });
  }
  return out;
}

function inspectProtectedPaths(
  checkoutDir: string,
  artifacts: readonly AcceptanceArtifact[],
  verify: (
    checkoutDir: string,
    artifacts: readonly AcceptanceArtifact[],
  ) => { path: string; reason: string }[],
): { path: string; reason: string }[] {
  try {
    return verify(checkoutDir, artifacts);
  } catch (error) {
    const reason = `protected path inspection failed: ${error instanceof Error ? error.message : String(error)}`;
    return artifacts.length > 0
      ? artifacts.map((artifact) => ({ path: artifact.relativePath, reason }))
      : [{ path: "<acceptance-inspection>", reason }];
  }
}

function normalizeChangedPath(path: string): string {
  return normalizeAcceptancePath(path);
}

function hasMatchingProtectedChangeWaiver(
  relativePath: string,
  waivers: readonly ProtectedChangeWaiver[] | undefined,
  scope: Omit<ProtectedChangeScope, "relativePath"> | undefined,
  validate: ((waiver: ProtectedChangeWaiver) => boolean) | undefined,
): boolean {
  if (!waivers || !scope || !validate) return false;
  return waivers.some((candidate) => {
    const parsed = ProtectedChangeWaiverSchema.safeParse(candidate);
    return parsed.success &&
      validate(parsed.data) &&
      matchesProtectedChangeWaiver(parsed.data, { ...scope, relativePath });
  });
}

export type BaselineFlakinessEvidence = BaselineFlakiness;

export interface BaselineStabilityResult {
  flaky: boolean;
  observations: readonly (readonly CheckResult[])[];
  evidence: BaselineFlakinessEvidence | null;
  evidenceRef: ArtifactRef | null;
}

/**
 * Confirm only an already-observed contradiction. Stable repeated observations incur no
 * extra executions; contradictory observations remain flaky even if later runs agree.
 */
export async function assessBaselineStability(input: {
  observations: readonly (readonly CheckResult[])[];
  confirm?: () => Promise<readonly CheckResult[]>;
  maxConfirmations?: number;
  persistEvidence?: (evidence: BaselineFlakinessEvidence) => ArtifactRef | Promise<ArtifactRef>;
}): Promise<BaselineStabilityResult> {
  const observations = input.observations.map((result) => [...result]);
  const signatures = observations.map(checkSetSignature);
  const contradictory = new Set(signatures).size > 1;
  if (!contradictory) return { flaky: false, observations, evidence: null, evidenceRef: null };

  const maxConfirmations = Math.max(0, Math.min(input.maxConfirmations ?? 1, 3));
  for (let i = 0; i < maxConfirmations && input.confirm; i++) {
    observations.push([...(await input.confirm())]);
  }
  const evidence: BaselineFlakinessEvidence = {
    kind: "baseline_flakiness",
    checkNames: [...new Set(observations.flatMap((set) => set.map((check) => check.name)))].sort(),
    observations,
    signatures: observations.map(checkSetSignature),
    confirmationRuns: observations.length - input.observations.length,
  };
  const evidenceRef = input.persistEvidence ? await input.persistEvidence(evidence) : null;
  return { flaky: true, observations, evidence, evidenceRef };
}

function checkSetSignature(checks: readonly CheckResult[]): string {
  return sha256Hex(canonicalJson(
    [...checks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ durationMs: _durationMs, outputRef: _outputRef, ...check }) => check),
  ));
}
