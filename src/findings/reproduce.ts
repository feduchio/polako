import { canonicalJson } from "../shared/hash.js";
import type { ArtifactRef } from "../domain/common.js";
import type { Finding } from "../domain/finding.js";
import { discoverProjectRuntime } from "../runtime/projectDiscovery.js";
import { discoverRuntimeValidator } from "../runtime/discovery.js";
import { FixtureRuntimeValidator } from "../runtime/fixtureRunner.js";
import { bindNodeScenario } from "../runtime/corpus.js";
import { PolishError } from "../shared/errors.js";
import type { EvidenceAttempt, FindingEvidenceWorker } from "./validator.js";

export interface ProjectEvidenceWorkerOptions {
  projectPath: string;
  persistOutput: (output: string, kind: string, label?: string) => ArtifactRef;
  now?: () => number;
}

/**
 * Production evidence worker: runs only the project's own runtime scenarios; never edits product
 * code. A finding's reproduction text is model output and is never executed here. Reproducing it is
 * the investigation's work, whose command the engine runs under the project's command policy.
 */
export class ProjectFindingEvidenceWorker implements FindingEvidenceWorker {
  private readonly now: () => number;

  constructor(private readonly options: ProjectEvidenceWorkerOptions) {
    this.now = options.now ?? Date.now;
  }

  async reproduce(finding: Finding): Promise<EvidenceAttempt> {
    const runtime = await this.tryRuntime(finding);
    if (runtime !== null) return runtime;
    return {
      method: "investigation",
      verdict: "UNCERTAIN",
      rationale: "no project runtime scenario applies to the finding; nothing was executed",
      evidenceRefs: [],
    };
  }

  private async tryRuntime(finding: Finding): Promise<EvidenceAttempt | null> {
    if (!wantsRuntime(finding)) return null;
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
    // The scenario is the project's, not this finding's reproduction: its result is context for the
    // investigation, never the verdict.
    if (evidence.status === "failed" || evidence.status === "passed") {
      return {
        method: "runtime_evidence",
        verdict: "UNCERTAIN",
        rationale: `project runtime scenario ${scenario.id} ${evidence.status}; it is not this finding's reproduction, so an investigation decides`,
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
}

function wantsRuntime(finding: Finding): boolean {
  const text = [
    finding.criterion,
    finding.claim,
    finding.suggestedCheck ?? "",
    ...finding.reproduction,
  ]
    .join(" ")
    .toLowerCase();
  return /\bruntime\b|scenario/.test(text);
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
