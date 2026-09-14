import type { CorpusEntry } from "../domain/acceptance.js";
import type { Actor, ArtifactRef } from "../domain/common.js";
import {
  FindingSchema,
  FindingValidationStrictSchema,
  findingStatusFromVerdict,
  type Finding,
  type FindingValidation,
  type ValidationMethod,
  type ValidationVerdict,
} from "../domain/finding.js";
import {
  createInvestigationTask,
  createTaskFromValidFinding,
  type Task,
  type TaskKind,
} from "../domain/task.js";
import type { Clock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { triageFinding, type FindingTriage } from "./triage.js";

export interface EvidenceAttempt {
  method: ValidationMethod;
  verdict: ValidationVerdict;
  rationale: string;
  evidenceRefs: ArtifactRef[];
  /** Causal event ids, when the harness persisted evidence as events. */
  corpusEvidenceRefs?: string[];
  performedBy?: Actor;
}

/** Evidence workers reproduce or disprove a claim; they never edit the product checkout. */
export interface FindingEvidenceWorker {
  reproduce(finding: Finding): Promise<EvidenceAttempt>;
}

export class ScriptedFindingEvidenceWorker implements FindingEvidenceWorker {
  constructor(private readonly script: (finding: Finding) => EvidenceAttempt | Promise<EvidenceAttempt>) {}

  reproduce(finding: Finding): Promise<EvidenceAttempt> {
    return Promise.resolve(this.script(finding));
  }
}

export interface CorpusAppender {
  record(entry: Omit<CorpusEntry, "id" | "createdAt" | "executable"> & { id?: string; executable?: CorpusEntry["executable"] }): CorpusEntry;
}

export interface FindingValidatorOptions {
  clock: Clock;
  worker: FindingEvidenceWorker;
  corpus: CorpusAppender;
  maxInvestigationRounds: number;
}

export interface ValidateFindingInput {
  finding: Finding;
  existingFindings: readonly Finding[];
  missionId: string;
  requirementRef: string;
  task?: {
    title?: string;
    description?: string;
    kind?: Exclude<TaskKind, "investigation">;
    acceptance?: string[];
    complexity?: Task["complexity"];
    dependsOn?: string[];
  };
}

export interface FindingValidationResult {
  finding: Finding;
  triage: FindingTriage;
  validation: FindingValidation | null;
  task: Task | null;
  corpusEntry: CorpusEntry | null;
}

export class FindingValidator {
  constructor(private readonly options: FindingValidatorOptions) {}

  async validate(input: ValidateFindingInput): Promise<FindingValidationResult> {
    if (input.finding.status !== "RAW") {
      throw new Error(`FindingValidator requires RAW finding, got ${input.finding.status}`);
    }
    const now = this.options.clock.now();
    const triage = triageFinding(input.finding, input.existingFindings);
    const triagedFinding = FindingSchema.parse({
      ...input.finding,
      fingerprint: triage.fingerprint,
      status: triage.disposition === "duplicate" ? "DUPLICATE" : triage.disposition === "noise" ? "NOTED" : "VALIDATING",
      duplicateOf: triage.disposition === "duplicate" ? triage.duplicateOf : null,
      updatedAt: now,
    });
    if (triage.disposition !== "validate") {
      return { finding: triagedFinding, triage, validation: null, task: null, corpusEntry: null };
    }

    const attempt = await this.options.worker.reproduce(triagedFinding);
    const validation = FindingValidationStrictSchema.parse({
      id: id("fval", now),
      findingId: triagedFinding.id,
      runId: triagedFinding.runId,
      method: attempt.method,
      verdict: attempt.verdict,
      rationale: attempt.rationale,
      evidenceRefs: attempt.evidenceRefs,
      performedBy: attempt.performedBy ?? { kind: "evidence_agent" },
      createdAt: now,
    });
    const finding = FindingSchema.parse({
      ...triagedFinding,
      status: findingStatusFromVerdict(validation.verdict),
      updatedAt: now,
    });

    if (validation.verdict === "REJECTED") {
      return { finding, triage, validation, task: null, corpusEntry: null };
    }

    const draft = {
      id: id("task", now),
      runId: finding.runId,
      title: input.task?.title ?? `${validation.verdict === "UNCERTAIN" ? "Investigate" : "Fix"}: ${finding.claim}`,
      description: input.task?.description ?? `WHAT: ${finding.claim}\nWHY: ${validation.rationale}`,
      acceptance: input.task?.acceptance ?? acceptanceFor(finding),
      complexity: input.task?.complexity ?? "normal",
      baseCheckpointHash: finding.checkpointHash,
      ...(input.task?.dependsOn === undefined ? {} : { dependsOn: input.task.dependsOn }),
      now,
    };

    if (validation.verdict === "UNCERTAIN") {
      const task =
        finding.investigationRounds < this.options.maxInvestigationRounds
          ? createInvestigationTask(finding, this.options.maxInvestigationRounds, draft)
          : null;
      return { finding, triage, validation, task, corpusEntry: null };
    }

    const corpusEntry = this.options.corpus.record({
      missionId: input.missionId,
      sourceRunId: finding.runId,
      requirementRef: input.requirementRef,
      kind: validation.method === "failing_test" ? "regression_test" : "runtime_scenario",
      summary: `Validated finding: ${finding.claim}`,
      evidenceRefs: attempt.corpusEvidenceRefs ?? [],
      artifactHashes: validation.evidenceRefs.map((ref) => ref.sha256),
      metadata: { findingId: finding.id, validationId: validation.id, method: validation.method },
    });

    if (!finding.blocking) {
      return { finding, triage, validation, task: null, corpusEntry };
    }

    const task = createTaskFromValidFinding(finding, validation, {
      ...draft,
      kind: input.task?.kind ?? "bugfix",
    });
    return { finding, triage, validation, task, corpusEntry };
  }
}

function acceptanceFor(finding: Finding): string[] {
  if (finding.suggestedCheck !== undefined) return [finding.suggestedCheck];
  if (finding.reproduction.length > 0) return [`The reproduction no longer demonstrates the issue: ${finding.reproduction.join(" → ")}`];
  return [`Independent gates show that "${finding.claim}" is resolved`];
}
