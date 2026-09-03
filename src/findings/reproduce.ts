import { canonicalJson } from "../shared/hash.js";
import type { ArtifactRef } from "../domain/common.js";
import type { Finding } from "../domain/finding.js";
import { discoverProjectRuntime } from "../runtime/projectDiscovery.js";
import { discoverRuntimeValidator } from "../runtime/discovery.js";
import { FixtureRuntimeValidator } from "../runtime/fixtureRunner.js";
import { bindNodeScenario } from "../runtime/corpus.js";
import { runProcess } from "../sandbox/process.js";
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
    const evidence = await selection.validator.validate(scenario);
    const artifact = this.options.persistOutput(canonicalJson(evidence), "runtime_evidence", scenario.id);
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
    const result = await runProcess({
      argv,
      cwd: this.options.projectPath,
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 120_000,
      maxOutputBytes: 512_000,
    });
    const artifact = this.options.persistOutput(canonicalJson(result), "test_output", argv.join(" "));
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
