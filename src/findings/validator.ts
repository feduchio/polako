import { CORPUS_EXECUTABLE_STATUS, type CorpusEntry } from "../domain/acceptance.js";
import type { Actor, ArtifactRef } from "../domain/common.js";
import {
  commitFindingStatus,
  FindingSchema,
  FindingValidationStrictSchema,
  findingStatusFromVerdict,
  type Finding,
  type FindingValidation,
  type ValidationMethod,
  type ValidationVerdict,
} from "../domain/finding.js";
import type { EvidenceOutcome } from "../domain/evidence.js";
import {
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
  /** Set by a worker whose own execution the engine judged; a VALID without `demonstrated` is doubt. */
  outcome?: EvidenceOutcome;
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
    const triagedStatus = triage.disposition === "duplicate" ? "DUPLICATE" : triage.disposition === "noise" ? "NOTED" : "VALIDATING";
    commitFindingStatus(input.finding.status, triagedStatus, input.finding.id);
    const triagedFinding = FindingSchema.parse({
      ...input.finding,
      fingerprint: triage.fingerprint,
      status: triagedStatus,
      duplicateOf: triage.disposition === "duplicate" ? triage.duplicateOf : null,
      updatedAt: now,
    });
    if (triage.disposition !== "validate") {
      return { finding: triagedFinding, triage, validation: null, task: null, corpusEntry: null };
    }

    const attempt = await this.options.worker.reproduce(triagedFinding);
    const performedBy = attempt.performedBy ?? { kind: "evidence_agent" as const };
    const earned = attempt.verdict !== "VALID" || (attempt.outcome === "demonstrated" && performedBy.kind === "system");
    const validation = FindingValidationStrictSchema.parse({
      id: id("fval", now),
      findingId: triagedFinding.id,
      runId: triagedFinding.runId,
      method: attempt.method,
      verdict: earned ? attempt.verdict : "UNCERTAIN",
      rationale: earned ? attempt.rationale : `${attempt.rationale}; no execution the engine judged demonstrated it`,
      evidenceRefs: attempt.evidenceRefs,
      ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome, reason: null }),
      performedBy,
      createdAt: now,
    });
    const validatedStatus = findingStatusFromVerdict(validation.verdict);
    commitFindingStatus(triagedFinding.status, validatedStatus, triagedFinding.id);
    const finding = FindingSchema.parse({
      ...triagedFinding,
      status: validatedStatus,
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

    // Doubt goes to debate, which routes it to an investigation; the validator creates no task for it.
    if (validation.verdict === "UNCERTAIN") return { finding, triage, validation, task: null, corpusEntry: null };

    const corpusEntry = this.options.corpus.record({
      missionId: input.missionId,
      sourceRunId: finding.runId,
      requirementRef: input.requirementRef,
      kind: "runtime_scenario",
      summary: `Validated finding: ${finding.claim}`,
      evidenceRefs: attempt.corpusEvidenceRefs ?? [],
      artifactHashes: validation.evidenceRefs.map((ref) => ref.sha256),
      metadata: {
        findingId: finding.id,
        validationId: validation.id,
        method: validation.method,
        executableStatus: finding.blocking
          ? CORPUS_EXECUTABLE_STATUS.pendingIntegration
          : CORPUS_EXECUTABLE_STATUS.noFixingTask,
      },
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
