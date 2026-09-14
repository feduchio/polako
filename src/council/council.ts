import type { BaselineSnapshot } from "../domain/checks.js";
import { EventSchema, type NewEvent } from "../domain/event.js";
import type { Mission } from "../domain/mission.js";
import {
  createMission,
  hasBlockingAmbiguity,
  MissionInterpretationSchema,
  RequirementSchema,
  type MissionInterpretation,
  type Requirement,
} from "../domain/mission.js";
import {
  createTaskFromRequirement,
  workClassDraftFields,
  type Task,
  type TaskKind,
} from "../domain/task.js";
import { profileCacheKey } from "../project/discovery.js";
import { buildBaselineEvidenceView, type CheckOutputReader } from "../project/baselineEvidence.js";
import type { ProjectProfile } from "../project/profile.js";
import { PolishError, errorToString, isOutputContractFailure, isProvidersUnavailable } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import { isOperationalFailure } from "./operational.js";
import { aggregateCouncilDecision } from "./judge.js";
import { outputContractError } from "./interpretationSchema.js";
import { intakeCouncilPayload } from "./profileHints.js";
import { Judge, Planner, ScopeGuardian } from "./roles.js";
import type {
  CouncilDecision,
  CouncilEventSink,
  CouncilRoleConfigs,
  IntakeResult,
  RoleOpinion,
  TaskDag,
} from "./types.js";

export interface SupervisorCouncilOptions {
  roles: CouncilRoleConfigs;
  eventSink?: CouncilEventSink;
  now?: () => number;
  runId?: string;
  baseCheckpointHash?: string;
}

export interface CouncilIntakeOptions {
  readCheckOutput?: CheckOutputReader;
  /** Latest durable answer when retrying a NEEDS_HUMAN intake. */
  humanAnswer?: string;
}

interface InterpretationProposal {
  goals?: unknown;
  requirements?: unknown;
  constraints?: unknown;
  nonGoals?: unknown;
  definitionOfSuccess?: unknown;
  ambiguities?: unknown;
}

interface TaskProposal {
  title?: unknown;
  description?: unknown;
  kind?: unknown;
  requirementRef?: unknown;
  acceptance?: unknown;
  complexity?: unknown;
  dependsOn?: unknown;
  workClass?: unknown;
  classifiedBy?: unknown;
  sourceRef?: unknown;
  classificationEventId?: unknown;
}

/** Three independent supervisor perspectives with explicit, evented aggregation. */
export class SupervisorCouncil {
  readonly planner: Planner;
  readonly scopeGuardian: ScopeGuardian;
  readonly judge: Judge;
  private readonly now: () => number;
  private baseline: BaselineSnapshot | undefined;
  private localSeq = 0;

  constructor(private readonly options: SupervisorCouncilOptions) {
    this.planner = new Planner(options.roles.planner);
    this.scopeGuardian = new ScopeGuardian(options.roles.scope_guardian);
    this.judge = new Judge(options.roles.judge);
    this.now = options.now ?? Date.now;
  }

  async intake(
    missionRaw: Mission | string,
    discovery: ProjectProfile,
    baseline: BaselineSnapshot,
    options: CouncilIntakeOptions = {},
  ): Promise<IntakeResult> {
    this.baseline = baseline;
    const mission = normalizeMission(missionRaw, discovery.projectPath, this.now());
    const baselineEvidence = buildBaselineEvidenceView(baseline, options.readCheckOutput ?? (() => null));
    const context = {
      ...intakeCouncilPayload(mission, discovery, baseline, baselineEvidence),
      ...(options.humanAnswer === undefined ? {} : { humanAnswer: options.humanAnswer }),
    };
    const labeled = [
      { role: "planner" as const, promise: this.planner.analyze({ runId: baseline.runId, purpose: "council_intake_planner", payload: context }) },
      { role: "scope_guardian" as const, promise: this.scopeGuardian.analyze({ runId: baseline.runId, purpose: "council_intake_scope", payload: context }) },
      { role: "judge" as const, promise: this.judge.analyze({ runId: baseline.runId, purpose: "council_intake_judge", payload: context }) },
    ];
    const calls = await settleCouncilRoles(labeled);
    const plannerCall = calls[0];
    const scopeCall = calls[1];
    const judgeCall = calls[2];
    if (plannerCall === undefined || scopeCall === undefined || judgeCall === undefined) {
      throw new PolishError("INVARIANT_VIOLATION", "council intake lost a sibling role result");
    }
    let interpretation: MissionInterpretation;
    try {
      interpretation = buildInterpretation(
        plannerCall.proposal,
        mission,
        discovery,
        baseline,
        this.options.roles.planner.model,
        this.now(),
      );
    } catch (error) {
      if (isOutputContractFailure(error)) throw error;
      throw outputContractError(
        error instanceof Error ? error.message : "planner interpretation failed schema validation",
        { causeMessage: error instanceof Error ? error.message : String(error) },
      );
    }
    const opinions = [plannerCall.opinion, scopeCall.opinion, judgeCall.opinion];
    const aggregate = aggregateCouncilDecision(opinions, { blockingAmbiguity: hasBlockingAmbiguity(interpretation) });
    const decision = this.recordDecision(
      baseline.runId,
      "intake",
      aggregate,
      opinions,
      calls.flatMap((call) => (call.modelEventId === undefined ? [] : [call.modelEventId])),
      { interpretationId: interpretation.id },
    );
    if (aggregate === "APPROVED") return { status: "READY", interpretation, decision };

    const blocking = interpretation.ambiguities.find((ambiguity) => ambiguity.blocking);
    return {
      status: "NEEDS_HUMAN",
      interpretation,
      decision,
      question: blocking?.question ?? firstConcern(opinions) ?? "Which direction should the council take?",
      options: (blocking?.options ?? ["Clarify the requested behavior", "Narrow the mission scope"]).slice(0, 5),
    };
  }

  async decompose(
    interpretation: MissionInterpretation,
    options: { humanAnswer?: string } = {},
  ): Promise<TaskDag> {
    if (hasBlockingAmbiguity(interpretation)) {
      throw new PolishError("INVARIANT_VIOLATION", "cannot decompose an interpretation with blocking ambiguity");
    }
    const runId = this.options.runId ?? this.baseline?.runId;
    const baseCheckpointHash = this.options.baseCheckpointHash ?? this.baseline?.commitHash;
    if (runId === undefined || baseCheckpointHash === undefined) {
      throw new PolishError("CONFIG_ERROR", "decompose requires prior intake or explicit runId and baseCheckpointHash");
    }
    const context = {
      interpretation,
      ...(options.humanAnswer === undefined ? {} : { humanAnswer: options.humanAnswer }),
    };
    const labeled = [
      { role: "planner" as const, promise: this.planner.analyze({ runId, purpose: "council_decompose_planner", payload: context }) },
      { role: "scope_guardian" as const, promise: this.scopeGuardian.analyze({ runId, purpose: "council_decompose_scope", payload: context }) },
      { role: "judge" as const, promise: this.judge.analyze({ runId, purpose: "council_decompose_judge", payload: context }) },
    ];
    const calls = await settleCouncilRoles(labeled);
    const plannerCall = calls[0];
    const scopeCall = calls[1];
    const judgeCall = calls[2];
    if (plannerCall === undefined || scopeCall === undefined || judgeCall === undefined) {
      throw new PolishError("INVARIANT_VIOLATION", "council decompose lost a sibling role result");
    }
    const opinions = [plannerCall.opinion, scopeCall.opinion, judgeCall.opinion];
    const aggregate = aggregateCouncilDecision(opinions);
    const causedBy = [plannerCall, scopeCall, judgeCall].flatMap((call) => (call.modelEventId === undefined ? [] : [call.modelEventId]));
    if (aggregate === "NEEDS_HUMAN") {
      const decision = this.recordDecision(runId, "decompose", "NEEDS_HUMAN", opinions, causedBy, {
        interpretationId: interpretation.id,
        reason: firstConcern(opinions) ?? "council requested human input",
      });
      return { tasks: [], roots: [], droppedRequirementRefs: [], decision };
    }

    const allDrafts = taskProposals(plannerCall.proposal, interpretation);
    const { kept, dropped } = applyScopeFilter(allDrafts, scopeCall.proposal, judgeCall.proposal);
    const drafts = kept;
    if (drafts.length === 0) {
      const decision = this.recordDecision(runId, "decompose", "NEEDS_HUMAN", opinions, causedBy, {
        interpretationId: interpretation.id,
        droppedRequirementRefs: dropped,
        reason: "no in-scope coding tasks remained",
      });
      return { tasks: [], roots: [], droppedRequirementRefs: dropped, decision };
    }
    const taskIds = drafts.map(() => id("task", this.now()));
    const classificationEventId = id("evt", this.now());
    const refToTask = new Map<string, string>();
    drafts.forEach((draft, index) => {
      if (typeof draft.requirementRef === "string" && taskIds[index] !== undefined) {
        refToTask.set(draft.requirementRef, taskIds[index]);
      }
    });
    const tasks = drafts.map((draft, index) => {
      const requirement = interpretation.requirements.find((item) => item.ref === draft.requirementRef);
      if (requirement === undefined) throw new PolishError("INVARIANT_VIOLATION", `unknown requirement ${String(draft.requirementRef)}`);
      const taskId = taskIds[index];
      if (taskId === undefined) throw new PolishError("INVARIANT_VIOLATION", "task id allocation failed");
      const dependencies = stringArray(draft.dependsOn).map((dependency) => refToTask.get(dependency) ?? dependency);
      const kind = taskKind(draft.kind);
      const structured = structuredWorkClass(draft, scopeCall.proposal, requirement.ref, plannerCall.modelEventId, scopeCall.modelEventId);
      return createTaskFromRequirement(interpretation.id, requirement.ref, {
        id: taskId,
        runId,
        title: stringValue(draft.title, requirement.statement),
        description: stringValue(
          draft.description,
          `WHAT: ${requirement.statement}\nWHY: mission requirement ${requirement.ref}\nCONSTRAINTS: ${interpretation.constraints.join("; ") || "none"}\nEVIDENCE: mission interpretation`,
        ),
        kind,
        acceptance: nonEmptyStrings(draft.acceptance, requirement.acceptance),
        complexity: complexity(draft.complexity),
        baseCheckpointHash,
        dependsOn: dependencies,
        now: this.now(),
        ...workClassDraftFields({
          kind,
          originKind: "mission_requirement",
          originRef: requirement.ref,
          workClass: structured.workClass,
          classifiedBy: structured.classifiedBy,
          sourceRef: structured.sourceRef,
          classificationEventId: structured.classificationEventId ?? classificationEventId,
        }),
      });
    });
    assertDag(tasks);
    const decision = this.recordDecision(
      runId,
      "decompose",
      "APPROVED",
      opinions,
      causedBy,
      { interpretationId: interpretation.id, taskIds: tasks.map((task) => task.id), droppedRequirementRefs: dropped },
      classificationEventId,
    );
    return {
      tasks,
      roots: tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id),
      droppedRequirementRefs: dropped,
      decision,
    };
  }

  private recordDecision(
    runId: string,
    stage: string,
    result: CouncilDecision["decision"],
    opinions: RoleOpinion[],
    causedBy: string[],
    extra: Record<string, unknown>,
    eventId?: string,
  ): CouncilDecision {
    const rationale = opinions.map((opinion) => `${opinion.role}: ${opinion.rationale}`).join(" | ");
    const event: NewEvent = {
      id: eventId ?? id("evt", this.now()),
      runId,
      ts: this.now(),
      type: "supervisor.decision",
      payload: { stage, decision: result, rationale, opinions, ...extra },
      causedBy,
      actor: { kind: "supervisor", role: "council" },
      artifacts: [],
    };
    const events = this.options.eventSink?.append([event]) ?? [
      EventSchema.parse({ ...event, seq: this.localSeq++ }),
    ];
    return { decision: result, rationale, opinions, events };
  }
}

function buildInterpretation(
  raw: unknown,
  mission: Mission,
  discovery: ProjectProfile,
  baseline: BaselineSnapshot,
  model: CouncilRoleConfigs["planner"]["model"],
  now: number,
): MissionInterpretation {
  const proposal = extractProposal(raw, "interpretation") as InterpretationProposal;
  const requirements = parseRequirements(proposal.requirements);
  if (requirements === null) {
    throw outputContractError("planner produced no valid requirements", {
      issues: [{ path: "$.requirements", message: "expected a non-empty array of requirement objects" }],
    });
  }
  const firstRequirement = requirements[0];
  if (firstRequirement === undefined) {
    throw outputContractError("planner produced no valid requirements");
  }
  const parsed = MissionInterpretationSchema.safeParse({
    id: id("mint", now),
    missionId: mission.id,
    version: 1,
    supersedes: null,
    basedOn: { profileHash: profileCacheKey(discovery), baselineId: baseline.id },
    goals: nonEmptyStrings(proposal.goals, [mission.text]),
    requirements,
    constraints: stringArray(proposal.constraints).length > 0 ? stringArray(proposal.constraints) : mission.userConstraints,
    nonGoals: stringArray(proposal.nonGoals),
    definitionOfSuccess: nonEmptyStrings(proposal.definitionOfSuccess, firstRequirement.acceptance),
    ambiguities: Array.isArray(proposal.ambiguities) ? proposal.ambiguities : [],
    createdBy: { kind: "supervisor", role: "planner", model },
    createdAt: now,
  });
  if (!parsed.success) {
    throw outputContractError("planner interpretation failed schema validation", {
      issues: parsed.error.issues.map((issue) => ({
        path: `$${issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`)).join("")}`,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function parseRequirements(raw: unknown): Requirement[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const requirements: Requirement[] = [];
  for (let index = 0; index < raw.length; index++) {
    const parsed = RequirementSchema.safeParse(raw[index]);
    if (!parsed.success) {
      throw outputContractError("planner interpretation requirements failed schema validation", {
        issues: parsed.error.issues.map((issue) => ({
          path: `$.requirements[${index}]${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}`,
          message: issue.message,
        })),
      });
    }
    requirements.push(parsed.data);
  }
  return requirements;
}

function normalizeMission(raw: Mission | string, projectPath: string, now: number): Mission {
  if (typeof raw !== "string") return raw;
  return createMission({
    id: id("msn"),
    projectPath,
    text: raw,
    createdAt: now,
  });
}

function taskProposals(raw: unknown, interpretation: MissionInterpretation): TaskProposal[] {
  const proposal = extractProposal(raw, "tasks");
  if (Array.isArray(proposal)) return proposal.filter(isRecord);
  return interpretation.requirements.map((requirement) => ({
    title: requirement.statement,
    description: `Implement ${requirement.ref}: ${requirement.statement}`,
    kind: "feature",
    requirementRef: requirement.ref,
    acceptance: requirement.acceptance,
    complexity: "normal",
    dependsOn: [],
  }));
}

function structuredWorkClass(
  draft: TaskProposal,
  scopeProposal: unknown,
  requirementRef: string,
  plannerEventId: string | undefined,
  scopeEventId: string | undefined,
): { workClass?: unknown; classifiedBy?: unknown; sourceRef?: unknown; classificationEventId?: unknown } {
  const fromScope = scopeStructuredWorkClass(scopeProposal, requirementRef);
  if (fromScope !== null) {
    return {
      workClass: fromScope.workClass,
      classifiedBy: fromScope.classifiedBy,
      sourceRef: fromScope.sourceRef,
      classificationEventId: existingEventId(fromScope.classificationEventId, scopeEventId),
    };
  }
  if (draft.workClass === undefined && draft.classifiedBy === undefined && draft.sourceRef === undefined) {
    return {};
  }
  return {
    workClass: draft.workClass,
    classifiedBy: draft.classifiedBy,
    sourceRef: draft.sourceRef,
    classificationEventId: existingEventId(draft.classificationEventId, plannerEventId),
  };
}

function scopeStructuredWorkClass(
  scopeProposal: unknown,
  requirementRef: string,
): { workClass?: unknown; classifiedBy?: unknown; sourceRef?: unknown; classificationEventId?: unknown } | null {
  const classifications = extractProposal(scopeProposal, "classifications");
  if (Array.isArray(classifications)) {
    const match = classifications.filter(isRecord).find((item) => item["requirementRef"] === requirementRef && item["workClass"] !== undefined);
    if (match !== undefined) {
      return {
        workClass: match["workClass"],
        classifiedBy: match["classifiedBy"],
        sourceRef: match["sourceRef"],
        classificationEventId: match["classificationEventId"],
      };
    }
  }
  const workClasses = extractProposal(scopeProposal, "workClasses");
  if (isRecord(workClasses)) {
    const match = workClasses[requirementRef];
    if (isRecord(match) && match["workClass"] !== undefined) {
      return {
        workClass: match["workClass"],
        classifiedBy: match["classifiedBy"],
        sourceRef: match["sourceRef"],
        classificationEventId: match["classificationEventId"],
      };
    }
  }
  return null;
}

function existingEventId(candidate: unknown, fallback: string | undefined): string | undefined {
  return typeof candidate === "string" && candidate === fallback ? candidate : fallback;
}

function applyScopeFilter(
  drafts: TaskProposal[],
  scopeProposal: unknown,
  judgeProposal: unknown,
): { kept: TaskProposal[]; dropped: string[] } {
  const dropRefs = new Set(stringArray(extractProposal(scopeProposal, "dropRefs")));
  const restoreRefs = new Set(stringArray(extractProposal(judgeProposal, "restoreRefs")));
  for (const ref of restoreRefs) dropRefs.delete(ref);
  if (dropRefs.size === 0) return { kept: drafts, dropped: [] };
  const dropped = drafts
    .filter((draft) => typeof draft.requirementRef === "string" && dropRefs.has(draft.requirementRef))
    .map((draft) => String(draft.requirementRef));
  const kept = drafts.filter((draft) => typeof draft.requirementRef !== "string" || !dropRefs.has(draft.requirementRef));
  return { kept, dropped };
}

function extractProposal(raw: unknown, key: string): unknown {
  if (!isRecord(raw)) return {};
  if (key in raw) return raw[key];
  if ("proposal" in raw && isRecord(raw["proposal"]) && key in raw["proposal"]) return raw["proposal"][key];
  return raw;
}

function assertDag(tasks: Task[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new PolishError("INVARIANT_VIOLATION", `task ${task.id} depends on unknown task ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new PolishError("INVARIANT_VIOLATION", "task decomposition contains a dependency cycle");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

function taskKind(value: unknown): Exclude<TaskKind, "investigation"> {
  return value === "bugfix" || value === "refactor" || value === "simplify" ? value : "feature";
}

function complexity(value: unknown): "trivial" | "normal" | "complex" {
  return value === "trivial" || value === "complex" ? value : "normal";
}

function nonEmptyStrings(value: unknown, fallback: string[]): string[] {
  const strings = stringArray(value);
  return strings.length > 0 ? strings : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function settleCouncilRoles<T>(labeled: readonly { role: "planner" | "scope_guardian" | "judge"; promise: Promise<T> }[]): Promise<T[]> {
  return Promise.allSettled(labeled.map((item) => item.promise)).then((settled) => {
    const outcomes: { role: "planner" | "scope_guardian" | "judge"; status: "fulfilled" | "rejected"; error?: string }[] = [];
    const rejected: { role: "planner" | "scope_guardian" | "judge"; reason: unknown }[] = [];
    const values: T[] = [];
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      const item = labeled[index];
      if (result === undefined || item === undefined) continue;
      if (result.status === "rejected") {
        outcomes.push({ role: item.role, status: "rejected", error: errorToString(result.reason) });
        rejected.push({ role: item.role, reason: result.reason });
      } else {
        outcomes.push({ role: item.role, status: "fulfilled" });
        values.push(result.value);
      }
    }
    if (rejected.length === 0) return values;
    const operational = rejected.filter((item) => isOperationalFailure(item.reason) || isProvidersUnavailable(item.reason));
    const first = operational[0];
    if (first !== undefined) {
      const details =
        first.reason instanceof PolishError
          ? { ...first.reason.details, siblingOutcomes: outcomes }
          : { siblingOutcomes: outcomes };
      throw new PolishError(
        "PROVIDERS_UNAVAILABLE",
        `council role(s) unavailable: ${operational.map((item) => item.role).join(", ")}`,
        details,
        first.reason instanceof Error ? { cause: first.reason } : undefined,
      );
    }
    const fallback = rejected[0];
    if (fallback === undefined) return values;
    throw fallback.reason;
  });
}

function firstConcern(opinions: RoleOpinion[]): string | undefined {
  return opinions.flatMap((opinion) => opinion.concerns)[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
