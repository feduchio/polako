import type { AcceptanceArtifact } from "../domain/acceptance.js";
import type { BaselineSnapshot, CheckDefinition, CheckResult } from "../domain/checks.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { id } from "../shared/ids.js";
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
}

/** Run project checks inside an isolated checkout and return structured results. */
export async function runChecks(opts: CheckRunOptions): Promise<CheckResult[]> {
  const checks = opts.only ? opts.profile.checks.filter((c) => opts.only?.includes(c.name)) : opts.profile.checks;
  const out: CheckResult[] = [];
  for (const def of checks) {
    out.push(await runOneCheck(opts, def));
  }
  return out;
}

async function runOneCheck(opts: CheckRunOptions, def: CheckDefinition): Promise<CheckResult> {
  const started = Date.now();
  try {
    const runOpts: { timeoutMs?: number; signal?: AbortSignal } = {};
    if (def.timeoutMs !== undefined) runOpts.timeoutMs = def.timeoutMs;
    if (opts.signal !== undefined) runOpts.signal = opts.signal;
    const result = await opts.sandbox.run(def.command, runOpts);
    const status = statusFromProcess(result.timedOut, result.aborted, result.exitCode);
    const summary = def.kind === "test" ? parseTestOutput(opts.profile.framework, result.stdout, result.stderr) : null;
    return {
      name: def.name,
      kind: def.kind,
      status,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      summary,
      outputRef: null,
    };
  } catch {
    return {
      name: def.name,
      kind: def.kind,
      status: "error",
      exitCode: null,
      durationMs: Date.now() - started,
      summary: null,
      outputRef: null,
    };
  }
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
  kind: "skip_only" | "removed_test_file" | "weakened_config" | "scripts_changed" | "suppress_comment";
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
    if (cand !== undefined && cand !== hash) {
      findings.push({ kind: "weakened_config", path, detail: "config file hash changed vs baseline" });
    }
  }
  for (const line of input.diffText.split("\n")) {
    if (/\.(only|skip)\(/.test(line)) {
      findings.push({ kind: "skip_only", path: "diff", detail: line.trim() });
    }
    if (/@ts-ignore|eslint-disable/.test(line)) {
      findings.push({ kind: "suppress_comment", path: "diff", detail: line.trim() });
    }
  }
  const baseTests = new Set(input.baseline.checks.filter((c) => c.kind === "test").map((c) => c.name));
  for (const f of input.changedFiles) {
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && input.diffText.includes(`deleted file mode`) && input.diffText.includes(f)) {
      findings.push({ kind: "removed_test_file", path: f, detail: "test file removed in candidate diff" });
    }
  }
  if (baseTests.size === 0 && input.changedFiles.some((f) => f.includes("vitest.config"))) {
    findings.push({ kind: "weakened_config", path: "vitest.config", detail: "test config touched" });
  }
  return findings;
}

export interface GateResult {
  checks: CheckResult[];
  silencing: SilencingFinding[];
  acceptanceProblems: { path: string; reason: string }[];
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
  verifyAcceptance: (checkoutDir: string) => { path: string; reason: string }[];
  materializeAcceptance: (checkoutDir: string) => void;
  candidateConfigHashes: Record<string, string>;
  candidateScriptsHash: string;
  changedFiles: readonly string[];
  diffText: string;
  baseline: BaselineSnapshot;
  signal?: AbortSignal;
}): Promise<GateResult> {
  input.materializeAcceptance(input.sandbox.path);
  const acceptanceProblems = input.verifyAcceptance(input.sandbox.path);
  const checkOpts: CheckRunOptions = {
    runId: input.runId,
    commitHash: input.commitHash,
    sandbox: input.sandbox,
    profile: input.profile,
  };
  if (input.signal !== undefined) checkOpts.signal = input.signal;
  const checks = await runChecks(checkOpts);
  const silencing = detectSilencing({
    baseline: input.baseline,
    candidateConfigHashes: input.candidateConfigHashes,
    candidateScriptsHash: input.candidateScriptsHash,
    changedFiles: input.changedFiles,
    diffText: input.diffText,
  });
  const mandatoryFailed = checks.some((c) => {
    const def = input.profile.checks.find((d) => d.name === c.name);
    return def?.mandatory && c.status !== "pass";
  });
  const passed = !mandatoryFailed && acceptanceProblems.length === 0 && silencing.length === 0;
  return { checks, silencing, acceptanceProblems, passed };
}
