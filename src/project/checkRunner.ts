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
import { DEFAULT_INSTALL_DEPENDENCIES, DEFAULT_INSTALL_TIMEOUT_MS } from "../domain/config.js";
import type { ProcessResult } from "../sandbox/process.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { PolishError } from "../shared/errors.js";
import { canonicalJson, sha256Hex } from "../shared/hash.js";
import { id } from "../shared/ids.js";
import { installCommandFor, untrustedForMissingDependencies } from "../shared/projectDependencies.js";
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
  /**
   * How to make the sandbox able to produce evidence before any check runs.
   *
   * **Omitting this prepares with defaults.** It is not a switch a caller opts into: three call
   * sites each remembering to ask is what made finding 54 survive six rounds of patches, and a
   * fourth would have forgotten too. Saying nothing means "prepare", so deleting the wiring at any
   * call site changes nothing; the only way to not prepare is to say `enabled: false`, which is a
   * refusal, not a skip — the checks still do not run.
   */
  prepareDependencies?: DependencyPreparation;
}

export interface DependencyPreparation {
  /** Default `true`. `false` keeps the refusal and declines the install that would clear it. */
  enabled?: boolean;
  timeoutMs?: number;
  /** Fired before the command runs, so a crash mid-install still leaves a record of it. */
  onStart?: (info: { command: readonly string[]; timeoutMs: number }) => void;
  /** Fired once preparation has settled, ready or not, for forensics. */
  onResult?: (result: EnsureDependenciesResult) => void;
}

/**
 * A sandbox produced results that say nothing about the project, so there is nothing to return.
 *
 * Thrown rather than returned because the alternative is exactly the defect: a `CheckResult`
 * describing the environment, which every consumer downstream reads as the project's own status.
 * Distinct from every other sandbox error because no retry of this run will change it — the caller
 * must turn it into a terminal, operator-readable state rather than let it recur on every tick.
 * The results are carried along so the refusal can be forensically explained. Finding 54.
 */
export class EnvironmentNotReadyError extends PolishError {
  readonly prepared: EnsureDependenciesResult;
  /** The checks whose results are not evidence, and why. Never empty. */
  readonly untrusted: readonly { name: string; reason: string }[];
  /** What those checks did produce. Recorded, but never as the project's status. */
  readonly checks: readonly CheckResult[];
  /** The most specific statement available of what is wrong. */
  readonly detail: string;

  constructor(
    prepared: EnsureDependenciesResult,
    untrusted: readonly { name: string; reason: string }[],
    checks: readonly CheckResult[],
  ) {
    const detail = prepared.detail ?? untrusted[0]?.reason ?? "dependencies unavailable";
    const names = untrusted.map((check) => check.name).join(", ");
    super("SANDBOX_ERROR", `no evidence from ${names}: ${detail}`, {
      environmentNotReady: true,
      repositorySide: prepared.repositorySide ?? false,
    });
    this.name = "EnvironmentNotReadyError";
    this.prepared = prepared;
    this.untrusted = untrusted;
    this.checks = checks;
    this.detail = detail;
  }
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
  // Inside the function that runs the checks, so that no caller can produce a CheckResult from a
  // sandbox nobody prepared. Three call sites each remembering to ask is how finding 54 survived
  // six rounds of patches.
  const prepared = await prepareSandbox(opts.sandbox, opts.profile, opts.prepareDependencies, opts.signal);
  const checks = opts.only ? opts.profile.checks.filter((c) => opts.only?.includes(c.name)) : opts.profile.checks;
  const out: CheckResult[] = [];
  for (const def of checks) {
    out.push(await runOneCheck(opts, def));
  }
  // Here rather than before the commands, even when preparation already failed: a check that
  // **passed** is evidence whatever the environment looked like, and refusing it would discard a
  // real observation — MC11, which review round 1 had to teach this item once already. Only the
  // results can say whether this sandbox spoke about the project. Finding 54.
  const untrusted = untrustedAmong(opts.sandbox, checks, out);
  if (untrusted.length > 0) throw new EnvironmentNotReadyError(prepared, untrusted, out);
  if ("baseline" in opts) {
    const regression = compareToBaseline(opts.baseline, out);
    return { checks: out, regression, passed: !hasRegression(regression) };
  }
  return out;
}

/**
 * Why a check run here would say nothing about the project, or `null` when it would.
 *
 * The resolved script text is passed as well as the argv: a profile check is `<pm> run <script>`,
 * and it is the script that says whether packages are needed. Without it the command-shape test
 * could never fire for a profile check.
 */
function untrustedCheckReason(sandbox: SandboxHandle, def: CheckDefinition): string | null {
  const cwd = resolve(sandbox.path, def.cwd ?? ".");
  return untrustedForMissingDependencies(cwd, def.command, resolvedScriptText(cwd, def));
}

/** The text of the package script a `<pm> run <name>` check invokes, when it is one. */
function resolvedScriptText(cwd: string, def: CheckDefinition): string | null {
  const [, verb, name] = def.command;
  if (verb !== "run" || name === undefined) return null;
  try {
    const manifest = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return manifest.scripts?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * The checks of a profile whose results would describe the environment rather than the project.
 *
 * `results` is required rather than optional: a check that **passed** is evidence whatever the
 * environment looked like, so refusing a snapshot because of it would discard a real observation.
 * Only a non-passing result can be untrusted.
 */
export function untrustedChecks(
  sandbox: SandboxHandle,
  profile: ProjectProfile,
  results: readonly CheckResult[],
): { name: string; reason: string }[] {
  return untrustedAmong(sandbox, profile.checks, results);
}

/**
 * The same question over a given set of definitions, which is what a run with `only` produced.
 * Asking it over the whole profile there would report a check that never ran.
 */
function untrustedAmong(
  sandbox: SandboxHandle,
  defs: readonly CheckDefinition[],
  results: readonly CheckResult[],
): { name: string; reason: string }[] {
  const out: { name: string; reason: string }[] = [];
  const byName = new Map(results.map((result) => [result.name, result]));
  for (const def of defs) {
    if (byName.get(def.name)?.status === "pass") continue;
    const reason = untrustedCheckReason(sandbox, def);
    if (reason !== null) out.push({ name: def.name, reason });
  }
  return out;
}

/** Whether any of a profile's checks cannot produce evidence here, before any of them has run. */
export function dependenciesUnavailableFor(sandbox: SandboxHandle, profile: ProjectProfile): string | null {
  for (const def of profile.checks) {
    const reason = untrustedCheckReason(sandbox, def);
    if (reason !== null) return reason;
  }
  return null;
}

export interface EnsureDependenciesResult {
  /** whether an install was issued */
  attempted: boolean;
  /** whether the project's checks can now produce evidence */
  ready: boolean;
  detail: string | null;
  /**
   * `true` when the reason it is not ready lives in the repository — a stale lockfile, an
   * unsupported package manager — rather than in the environment. This run is pinned to a
   * checkpoint, so a repository-side repair needs a new commit and a new run; the caller must not
   * tell the operator that retrying will help. Finding 54.
   */
  repositorySide?: boolean;
  /** The full process result, so a timeout or an abort is distinguishable from an exit code. */
  output?: ProcessResult;
  /**
   * Top-level paths the install created that git would otherwise treat as new work — typically
   * `node_modules` in a repository that does not ignore it. The sandbox's git leaves them out of
   * commits and diffs from here on.
   */
  installedPaths?: string[];
}

/**
 * Make a sandbox able to produce evidence about the project, by installing its dependencies when
 * they are not reachable there.
 *
 * This is the half of finding 54's remedy that makes a *trusted* baseline obtainable. It is not the
 * whole remedy: install can be disabled, can fail, or can leave the project still unusable, and in
 * every one of those cases the checks must not run. `runChecks` calls this and refuses on its
 * result, which is why no caller has to. The install's output is returned as forensics; it is not
 * one of the project's checks.
 */
export async function ensureProjectDependencies(
  sandbox: SandboxHandle,
  profile: ProjectProfile,
  options: {
    enabled: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Fired before the command runs, so a crash mid-install still leaves a record of it. */
    onStart?: (info: { command: readonly string[]; timeoutMs: number }) => void;
  },
): Promise<EnsureDependenciesResult> {
  const missing = dependenciesUnavailableFor(sandbox, profile);
  if (missing === null) return { attempted: false, ready: true, detail: null };
  if (!options.enabled) return { attempted: false, ready: false, detail: "dependency install is disabled" };
  const argv = installCommandFor(profile.packageManager);
  if (argv === null) {
    return {
      attempted: false,
      ready: false,
      // The manifest names a package manager we cannot drive; that is a repository fact.
      repositorySide: true,
      detail: `no install command for package manager ${profile.packageManager ?? "unknown"}`,
    };
  }
  const runOpts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: options.timeoutMs };
  if (options.signal !== undefined) runOpts.signal = options.signal;
  options.onStart?.({ command: argv, timeoutMs: options.timeoutMs });
  const untrackedBefore = await topLevelUntracked(sandbox);
  let result: ProcessResult;
  try {
    result = await sandbox.run(argv, runOpts);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { attempted: true, ready: false, detail: `install failed to start: ${message}` };
  }
  if (result.timedOut) {
    return { attempted: true, ready: false, detail: `install timed out after ${String(options.timeoutMs)}ms`, output: result };
  }
  if (result.aborted) {
    return { attempted: true, ready: false, detail: "install aborted", output: result };
  }
  if (result.exitCode !== 0) {
    // Deliberately **not** marked repository-side. A non-zero install can be the repository's own
    // state — a stale lockfile, an unsupported package-manager version — or it can be a registry
    // outage, DNS, auth or a full disk. We cannot tell which from an exit code, and claiming the
    // repository is at fault would send the operator to fix the wrong thing. The instruction for
    // this case has to name both possibilities.
    return { attempted: true, ready: false, detail: `install exited ${String(result.exitCode)}`, output: result };
  }
  const installedPaths = await excludeInstalledPaths(sandbox, untrackedBefore);
  const stillMissing = dependenciesUnavailableFor(sandbox, profile);
  return stillMissing === null
    ? { attempted: true, ready: true, detail: null, output: result, ...(installedPaths.length === 0 ? {} : { installedPaths }) }
    : {
        attempted: true,
        ready: false,
        repositorySide: true,
        detail: "install succeeded but dependencies are still unreachable",
        output: result,
      };
}

/** Top-level untracked, non-ignored entries; null when the sandbox has no git to ask. */
async function topLevelUntracked(sandbox: SandboxHandle): Promise<Set<string> | null> {
  const git = sandbox.git as SandboxHandle["git"] | undefined;
  if (git === undefined || typeof git.out !== "function") return null;
  try {
    const text = await git.out(["ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory"]);
    return new Set(text.split("\n").map((line) => line.trim().split("/")[0] ?? "").filter((entry) => entry !== ""));
  } catch {
    return null;
  }
}

async function excludeInstalledPaths(sandbox: SandboxHandle, before: Set<string> | null): Promise<string[]> {
  if (before === null) return [];
  const after = await topLevelUntracked(sandbox);
  if (after === null) return [];
  const installed = [...after].filter((entry) => !before.has(entry)).sort();
  if (installed.length > 0 && typeof sandbox.git.exclude === "function") sandbox.git.exclude(installed);
  return installed;
}

/**
 * One preparation per sandbox, whoever asks for it.
 *
 * A sandbox is a one-shot checkout, so the answer cannot change between two callers and a second
 * install would be a second ten-minute `npm ci` for nothing. Memoizing the *promise* also makes
 * concurrent askers share one install rather than race it.
 *
 * This exists because two steps need it at different moments and neither may be the only one:
 * `runIndependentGates` needs the filesystem settled before it verifies acceptance artifacts,
 * and `runChecks` needs it settled before any command runs. Finding 54.
 */
const PREPARED_SANDBOXES = new WeakMap<SandboxHandle, Promise<EnsureDependenciesResult>>();

function prepareSandbox(
  sandbox: SandboxHandle,
  profile: ProjectProfile,
  prepare: DependencyPreparation | undefined,
  signal: AbortSignal | undefined,
): Promise<EnsureDependenciesResult> {
  const existing = PREPARED_SANDBOXES.get(sandbox);
  if (existing !== undefined) return existing;
  const running = ensureProjectDependencies(sandbox, profile, {
    enabled: prepare?.enabled ?? DEFAULT_INSTALL_DEPENDENCIES,
    timeoutMs: prepare?.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
    ...(prepare?.onStart === undefined ? {} : { onStart: prepare.onStart }),
  }).then((result) => {
    prepare?.onResult?.(result);
    return result;
  });
  PREPARED_SANDBOXES.set(sandbox, running);
  return running;
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
    const processStatus = statusFromProcess(result.timedOut, result.aborted, result.exitCode);
    // A failure produced where the project's packages are not installed is a statement about the
    // environment, so it is recorded as `error` rather than as the project's `fail`, and carries
    // no fingerprint: a fingerprint is the handle by which two failures are asserted to be the
    // same one, and withholding it makes the baseline comparison fail closed. Finding 54.
    //
    // `runChecks` refuses before the first command, so this is the backstop for what it cannot
    // see: an environment that stops being usable *while* the checks run — a script that clears
    // `node_modules`, a check whose own directory differs from the one preparation examined.
    const untrusted = processStatus === "pass" ? null : untrustedCheckReason(opts.sandbox, def);
    const status = untrusted === null ? processStatus : "error";
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
      status === "pass" || untrusted !== null
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
    // A failure to start the command in an environment that cannot produce evidence gets no
    // fingerprint either: the fingerprint is what lets two failures be called the same one.
    const spawnUntrusted = untrustedCheckReason(opts.sandbox, def);
    return {
      name: def.name,
      kind: def.kind,
      status: "error",
      exitCode: null,
      durationMs: Date.now() - started,
      summary: null,
      outputRef,
      ...(spawnUntrusted !== null
        ? {}
        : {
            failureFingerprint: computeFailureFingerprint({
              kind: def.kind,
              status: "error",
              exitCode: null,
              summary: null,
              diagnostics: [normalizeDiagnostics(stderr)],
            }),
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

/**
 * Compare a candidate diff + configs against baseline artifacts to detect silencing.
 *
 * `null` hashes mean this observation has nothing to compare them with — see `CheckoutCapture` —
 * and the hash rules are skipped rather than run against a reference from another moment.
 */
export function detectSilencing(input: {
  baseline: BaselineSnapshot;
  candidateConfigHashes: Record<string, string> | null;
  candidateScriptsHash: string | null;
  changedFiles: readonly string[];
  diffText: string;
}): SilencingFinding[] {
  const findings: SilencingFinding[] = [];
  const candidateConfigHashes = input.candidateConfigHashes;
  if (input.candidateScriptsHash !== null && input.candidateScriptsHash !== input.baseline.scriptsHash) {
    findings.push({ kind: "scripts_changed", path: "package.json", detail: "scripts block hash changed vs baseline" });
  }
  if (candidateConfigHashes !== null) {
    for (const [path, hash] of Object.entries(input.baseline.configHashes)) {
      const cand = candidateConfigHashes[path];
      if (cand === undefined) {
        findings.push({ kind: "weakened_config", path, detail: "config file removed vs baseline" });
      } else if (cand !== hash) {
        findings.push({ kind: "weakened_config", path, detail: "config file hash changed vs baseline" });
      }
    }
    for (const path of Object.keys(candidateConfigHashes)) {
      if (isTestConfigPath(path) && input.baseline.configHashes[path] === undefined) {
        findings.push({ kind: "weakened_config", path, detail: "test config introduced vs baseline" });
      }
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
  /** Forwarded to `runChecks`; omitting it prepares with defaults, as everywhere else. */
  prepareDependencies?: DependencyPreparation;
  protectedChangeWaivers?: readonly ProtectedChangeWaiver[];
  protectedChangeScope?: Omit<ProtectedChangeScope, "relativePath">;
  /** Store-backed authority check; schema-valid waiver objects alone are never trusted. */
  validateProtectedChangeWaiver?: (waiver: ProtectedChangeWaiver) => boolean;
}): Promise<GateResult> {
  // What the candidate did is read from the checkout **before** anything is installed into it.
  // An install writes an untracked `node_modules`, and a repository that does not ignore it would
  // hand git's answer to the silencing detector as the candidate's own work. Finding 54.
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
  let candidateCapture: CheckoutCapture;
  try {
    candidateCapture = await captureCheckout(input.sandbox, input.baseline.commitHash, {
      phase: "candidate",
      changedFiles: actualChangedFiles,
    });
  } catch (error) {
    const reason = `candidate silencing inspection failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      checks: [],
      silencing: [{ kind: "weakened_config", path: "<candidate-checkout>", detail: reason }],
      acceptanceProblems: [],
      candidateProtectedPathProblems: [],
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

  // Install before the artifacts are put in place, not after. An install runs the project's own
  // lifecycle scripts, so materializing and verifying first would certify bytes the install is
  // still free to replace, and the checks would then run against the replacement. Materialization
  // after it means the checks see canonical bytes even when an install overwrote them, and the
  // verification below is of what is actually on disk when the commands run. `runChecks` prepares
  // too and receives this same settled result rather than a second install. Finding 54.
  await prepareSandbox(input.sandbox, input.profile, input.prepareDependencies, input.signal);
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
  if (acceptanceProblems.length > 0) {
    // Do not run the checks. The acceptance artifacts are the thing the checks are supposed to
    // exercise, and we have just established that what is on disk is not them; a result produced
    // against a modified or missing artifact would be a statement about something else. The gate
    // already fails on this, so the only thing running would add is a misleading result set.
    return {
      checks: [],
      silencing: [],
      acceptanceProblems,
      candidateProtectedPathProblems,
      regression: compareToBaseline(input.baseline, []),
      passed: false,
    };
  }
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
  if (input.prepareDependencies !== undefined) checkOpts.prepareDependencies = input.prepareDependencies;
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
  // The tree as it stands now, tracked files only. The candidate's capture was taken before the
  // install and answers "what did the candidate do"; this one answers "what is in the checkout the
  // checks just ran against", which is a different question the moment anything else writes to it
  // — a lifecycle script, or a check command. Untracked files are excluded because by now the
  // biggest of them is the `node_modules` we installed. Finding 54.
  let settledCapture: CheckoutCapture;
  try {
    settledCapture = await captureCheckout(input.sandbox, input.baseline.commitHash, { phase: "settled" });
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
  // Each capture is judged **whole and on its own**: its diff with its own file list and its own
  // manifest hashes, from the moment it was taken. Two reasons, and both were defects first. One
  // parser given two states of a file lets a deletion in the earlier state cancel an
  // additions-only wrap in the later one. And pairing the earlier diff with the *later* hashes
  // loses everything the candidate did and then undid — a script that edits `package.json`, runs,
  // and restores it is invisible to a hash read at the end. Finding 54.
  const captures = sameCapture(candidateCapture, settledCapture)
    ? [candidateCapture]
    : [candidateCapture, settledCapture];
  const silencing = dedupeSilencing([
    ...captures.flatMap((capture) => [
      ...detectSilencing({
        baseline: input.baseline,
        candidateConfigHashes: capture.configHashes,
        candidateScriptsHash: capture.scriptsHash,
        changedFiles: capture.changedFiles,
        diffText: capture.diffText,
      }),
      ...silencingFromDistantWrap(input.baseline, evaluation.regression.newlyPassing, capture.diffText),
    ]),
    ...silencingFromSkippedBaselineFailures(input.baseline, checks, evaluation.regression.newlyPassing),
  ]).filter((finding) => !waivedSilencingPaths.has(normalizeChangedPath(finding.path)));
  const regression = evaluation.regression;
  const passed = evaluation.passed && acceptanceProblems.length === 0 && silencing.length === 0;
  return { checks, silencing, acceptanceProblems, candidateProtectedPathProblems, regression, passed };
}

/**
 * Everything the silencing detectors read about a checkout, from one moment.
 *
 * A value rather than four loose variables because the defect this item kept producing was always
 * the same: evidence from one moment evaluated against metadata from another. A gate reads the
 * checkout twice — before the install, which is what the candidate did, and after the checks,
 * which is what the verdict is about — and mixing a diff from one with hashes from the other loses
 * exactly the changes made and then undone in between. Finding 54.
 */
interface CheckoutCapture {
  phase: "candidate" | "settled";
  changedFiles: string[];
  diffText: string;
  /**
   * `null` for the settled capture, and that is a statement rather than a gap: the baseline's
   * hashes were taken from the project's source, so a hash read after an install has nothing at
   * the same moment to be compared with, and comparing anyway reports the installer's own work as
   * the candidate's. The settled capture answers with its diff, which *is* relative to the commit
   * the baseline describes.
   */
  configHashes: Record<string, string> | null;
  scriptsHash: string | null;
}

/**
 * `candidate` includes untracked files, because a file the candidate added without committing it is
 * its work. `settled` does not, because by then the untracked part of the checkout is dominated by
 * the `node_modules` we installed, and its file list comes from the diff for the same reason.
 */
async function captureCheckout(
  sandbox: SandboxHandle,
  base: string,
  input: { phase: "candidate"; changedFiles: readonly string[] } | { phase: "settled" },
): Promise<CheckoutCapture> {
  if (input.phase === "settled") {
    const diffText = await inspectCandidateDiff(sandbox, base, { trackedOnly: true });
    return {
      phase: "settled",
      changedFiles: changedPathsInDiff(diffText),
      diffText,
      configHashes: null,
      scriptsHash: null,
    };
  }
  const diffText = await inspectCandidateDiff(sandbox, base, { trackedOnly: false });
  const hashes = inspectManifestHashes(sandbox.path);
  return {
    phase: "candidate",
    changedFiles: input.changedFiles.map(normalizeChangedPath),
    diffText,
    configHashes: hashes.manifestHashes,
    scriptsHash: hashes.scriptsHash,
  };
}

function changedPathsInDiff(diffText: string): string[] {
  const paths = new Set<string>();
  for (const line of diffText.split("\n")) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git?.[2] !== undefined) paths.add(normalizeChangedPath(git[2]));
  }
  return [...paths];
}

/** Whether the checkout said the same thing twice, in which case one judgement is enough. */
function sameCapture(a: CheckoutCapture, b: CheckoutCapture): boolean {
  return a.diffText === b.diffText &&
    a.scriptsHash === b.scriptsHash &&
    canonicalJson(a.configHashes) === canonicalJson(b.configHashes) &&
    canonicalJson(a.changedFiles) === canonicalJson(b.changedFiles);
}

/** Two captures of one checkout report the same tracked edit twice; it is still one finding. */
function dedupeSilencing(findings: readonly SilencingFinding[]): SilencingFinding[] {
  const seen = new Set<string>();
  const out: SilencingFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.kind}\0${finding.path}\0${finding.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
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

/**
 * The candidate's work as a diff.
 *
 * `trackedOnly` asks the narrower question — what the project's own files look like now — which is
 * the right one once we have installed dependencies into the checkout ourselves. Finding 54.
 */
async function inspectCandidateDiff(
  sandbox: SandboxHandle,
  base: string,
  options: { trackedOnly?: boolean } = {},
): Promise<string> {
  // Absent, not failing, is what falls through: a stub git object in a test has no such method,
  // while a real one that throws has failed to answer, and the caller turns that into a refused
  // gate. Swallowing it would silently substitute `git diff base..HEAD`, which cannot see a
  // working-tree edit at all — the exact thing the second read exists to find. Finding 54.
  const git = sandbox.git;
  if (options.trackedOnly === true) {
    if (typeof git.trackedDiffAgainst === "function") return await git.trackedDiffAgainst(base);
  } else if (typeof git.diffAgainst === "function") {
    return await git.diffAgainst(base);
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
