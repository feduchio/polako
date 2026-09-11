import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../shared/hash.js";
import type { ArtifactRef } from "../domain/common.js";
import type { Finding } from "../domain/finding.js";
import { discoverProjectRuntime } from "../runtime/projectDiscovery.js";
import { discoverRuntimeValidator } from "../runtime/discovery.js";
import { FixtureRuntimeValidator } from "../runtime/fixtureRunner.js";
import { bindNodeScenario } from "../runtime/corpus.js";
import { runProcess, type ProcessResult } from "../sandbox/process.js";
import { PolishError } from "../shared/errors.js";
import type { EvidenceAttempt, FindingEvidenceWorker } from "./validator.js";

export interface ProjectEvidenceWorkerOptions {
  projectPath: string;
  persistOutput: (output: string, kind: string, label?: string) => ArtifactRef;
  now?: () => number;
}

/** Production evidence worker: reproduce via runtime scenarios or failing tests; never edits product code. */
export class ProjectFindingEvidenceWorker implements FindingEvidenceWorker {
  private readonly now: () => number;

  constructor(private readonly options: ProjectEvidenceWorkerOptions) {
    this.now = options.now ?? Date.now;
  }

  async reproduce(finding: Finding): Promise<EvidenceAttempt> {
    const runtime = await this.tryRuntime(finding);
    if (runtime !== null) return runtime;
    const test = await this.tryFailingTest(finding);
    if (test !== null) return test;
    return {
      method: "investigation",
      verdict: "UNCERTAIN",
      rationale: "no deterministic reproduction path matched the finding evidence",
      evidenceRefs: [],
    };
  }

  private async tryRuntime(finding: Finding): Promise<EvidenceAttempt | null> {
    const hints = reproductionHints(finding);
    if (!hints.runtime) return null;
    const discovery = discoverProjectRuntime(this.options.projectPath);
    const template = discovery.templates[0];
    if (template === undefined) {
      return {
        method: "runtime_evidence",
        verdict: "UNCERTAIN",
        rationale: `runtime reproduction requested but project has no safe scenario (${discovery.reason})`,
        evidenceRefs: [],
      };
    }
    const scenario = bindNodeScenario({
      template,
      projectPath: this.options.projectPath,
      runId: finding.runId,
      checkpointHash: finding.checkpointHash,
    });
    const selection = await discoverRuntimeValidator("auto", scenario, [new FixtureRuntimeValidator({ now: this.now })]);
    if (selection.validator === null) {
      return {
        method: "runtime_evidence",
        verdict: "UNCERTAIN",
        rationale: selection.reason,
        evidenceRefs: [],
      };
    }
    let evidence;
    try {
      evidence = await selection.validator.validate(scenario);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        method: "runtime_evidence",
        verdict: "UNCERTAIN",
        rationale: environmentFailureFromError(err) ?? `runtime evidence failed before the runner started: ${message}`,
        evidenceRefs: [],
      };
    }
    const artifact = this.options.persistOutput(canonicalJson(evidence), "runtime_evidence", scenario.id);
    const envReason = environmentFailureFromText(`${evidence.summary}\n${canonicalJson(evidence.observations)}`);
    if (envReason !== null) {
      return {
        method: "runtime_evidence",
        verdict: "UNCERTAIN",
        rationale: envReason,
        evidenceRefs: [artifact],
      };
    }
    if (evidence.status === "failed") {
      return {
        method: "runtime_evidence",
        verdict: "VALID",
        rationale: `runtime scenario ${scenario.id} failed and reproduced the defect`,
        evidenceRefs: [artifact],
      };
    }
    if (evidence.status === "passed") {
      return {
        method: "runtime_evidence",
        verdict: "REJECTED",
        rationale: `runtime scenario ${scenario.id} passed; defect was not reproduced`,
        evidenceRefs: [artifact],
      };
    }
    return {
      method: "runtime_evidence",
      verdict: "UNCERTAIN",
      rationale: evidence.summary,
      evidenceRefs: [artifact],
    };
  }

  private async tryFailingTest(finding: Finding): Promise<EvidenceAttempt | null> {
    const hints = reproductionHints(finding);
    if (!hints.test) return null;
    const argv = testCommand(finding);
    if (argv === null) {
      return {
        method: "failing_test",
        verdict: "UNCERTAIN",
        rationale: "test reproduction was requested but no runnable command was inferred",
        evidenceRefs: [],
      };
    }
    const missingDeps = missingInstalledDependencies(this.options.projectPath, argv);
    if (missingDeps !== null) {
      return {
        method: "failing_test",
        verdict: "UNCERTAIN",
        rationale: missingDeps,
        evidenceRefs: [],
      };
    }
    try {
      const result = await runProcess({
        argv,
        cwd: this.options.projectPath,
        env: { PATH: process.env["PATH"] ?? "" },
        timeoutMs: 120_000,
        maxOutputBytes: 512_000,
      });
      const artifact = this.options.persistOutput(canonicalJson(result), "test_output", argv.join(" "));
      const envReason = environmentFailureFromResult(result);
      if (envReason !== null) {
        return {
          method: "failing_test",
          verdict: "UNCERTAIN",
          rationale: envReason,
          evidenceRefs: [artifact],
        };
      }
      if (result.exitCode !== 0) {
        return {
          method: "failing_test",
          verdict: "VALID",
          rationale: `command failed with exit code ${result.exitCode ?? "null"} and reproduced the defect`,
          evidenceRefs: [artifact],
        };
      }
      return {
        method: "failing_test",
        verdict: "REJECTED",
        rationale: "command passed; the reported defect was not reproduced",
        evidenceRefs: [artifact],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const artifact = this.options.persistOutput(canonicalJson({ error: message }), "test_output", argv.join(" "));
      return {
        method: "failing_test",
        verdict: "UNCERTAIN",
        rationale: environmentFailureFromError(err) ?? `evidence command failed before the test runner started: ${message}`,
        evidenceRefs: [artifact],
      };
    }
  }
}

function reproductionHints(finding: Finding): { runtime: boolean; test: boolean } {
  const text = [
    finding.criterion,
    finding.claim,
    finding.suggestedCheck ?? "",
    ...finding.reproduction,
  ]
    .join(" ")
    .toLowerCase();
  return {
    runtime: /\bruntime\b|\.mjs\b|scenario/.test(text),
    test: /\btest\b|vitest|jest|regression|pnpm test|npm test/.test(text),
  };
}

function testCommand(finding: Finding): string[] | null {
  for (const step of finding.reproduction) {
    const trimmed = step.trim();
    if (/^(pnpm|npm|npx|yarn)\b/.test(trimmed)) return trimmed.split(/\s+/);
  }
  if (finding.suggestedCheck !== undefined && /test|vitest|jest/i.test(finding.suggestedCheck)) {
    return ["pnpm", "test"];
  }
  return null;
}

function missingInstalledDependencies(cwd: string, argv: readonly string[]): string | null {
  if (existsSync(join(cwd, "node_modules"))) return null;
  if (!existsSync(join(cwd, "package.json"))) return null;
  const script = packageTestScript(cwd);
  const haystack = `${argv.join(" ")}\n${script ?? ""}`;
  if (/node_modules|(?<![a-z])(vitest|jest|mocha|ava)(?![a-z])/i.test(haystack)) {
    return "missing installed dependencies";
  }
  return null;
}

function packageTestScript(cwd: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts?.["test"] ?? null;
  } catch {
    return null;
  }
}

function environmentFailureFromResult(result: ProcessResult): string | null {
  const output = `${result.stdout}\n${result.stderr}`;
  const fromText = environmentFailureFromText(output);
  if (fromText !== null) return fromText;
  if (result.exitCode === 127) return "command not found before the test runner started";
  if (result.exitCode !== 0 && !testRunnerStarted(output)) {
    return "failure before the test runner started";
  }
  return null;
}

function environmentFailureFromError(err: unknown): string | null {
  if (err instanceof PolishError && err.code === "SANDBOX_ERROR") {
    return environmentFailureFromText(err.message) ?? `command-not-found or spawn failure: ${err.message}`;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "command not found";
  return environmentFailureFromText(err instanceof Error ? err.message : String(err));
}

function environmentFailureFromText(output: string): string | null {
  if (/command not found|failed to spawn|enoent|not recognized as an internal or external command/i.test(output)) {
    return "command not found before the test runner started";
  }
  if (
    /cannot find module|cannot find package|err_module_not_found|err_pnpm_|npm err!.*(?:enoent|missing|not found)|not found: (?:vitest|jest|mocha)|'vitest' is not recognized/i.test(
      output,
    )
  ) {
    return "missing installed dependencies";
  }
  return null;
}

function testRunnerStarted(output: string): boolean {
  return (
    /\bTAP version\b/i.test(output) ||
    /\bTest Files\b/.test(output) ||
    /\bTest Suites:\b/.test(output) ||
    /^PASS /m.test(output) ||
    /^FAIL /m.test(output) ||
    /\b# tests\b/.test(output) ||
    /\bRUN {2}v\d/.test(output)
  );
}
