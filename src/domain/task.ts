import { z } from "zod";
import type { TransitionTable } from "./fsm.js";
import { GitHashSchema, IdSchema, TimestampSchema } from "./common.js";
import { FindingValidationStrictSchema, type Finding, type FindingValidation } from "./finding.js";
import { PolishError } from "../shared/errors.js";

/**
 * Closed set of task origins. This is a hard invariant: a coding task can only come from
 * (a) a VALID blocking finding, (b) an explicit mission requirement, or (c) the outcome of
 * an investigation. UNCERTAIN findings may only spawn `investigation` tasks, which are
 * forbidden from touching product code. REJECTED findings spawn nothing.
 */
export const TaskOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("valid_finding"),
    findingId: IdSchema,
    validationId: IdSchema,
    /** literal captured at creation; anything but VALID cannot be represented */
    verdict: z.literal("VALID"),
  }),
  z.object({
    kind: z.literal("mission_requirement"),
    interpretationId: IdSchema,
    requirementRef: z.string().regex(/^R\d+$/),
  }),
  z.object({
    kind: z.literal("investigation"),
    findingId: IdSchema,
    round: z.number().int().positive(),
  }),
]);
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;

export const TaskKindSchema = z.enum(["bugfix", "feature", "refactor", "simplify", "investigation"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/** Orthogonal to TaskOrigin. Missing historical values are functional (fail-safe). */
export const TaskWorkClassSchema = z.enum(["functional", "style_only"]);
export type TaskWorkClass = z.infer<typeof TaskWorkClassSchema>;

export const TaskWorkClassProvenanceSchema = z.object({
  workClass: TaskWorkClassSchema,
  classifiedBy: z.string().min(1),
  sourceRef: z.string().min(1),
  classificationEventId: IdSchema,
});
export type TaskWorkClassProvenance = z.infer<typeof TaskWorkClassProvenanceSchema>;

export const TaskStateSchema = z.enum([
  "PENDING",
  "READY",
  "RUNNING",
  "GATED",
  "SELECTED",
  "INTEGRATING",
  "INTEGRATED",
  "INTEGRATION_FAILED",
  "REJECTED",
  "BLOCKED",
  "CANCELLED",
  /**
   * Done without an integrated change, on evidence the engine produced itself: an investigation
   * whose reproduction the engine re-ran to a verdict, or a coding task whose acceptance already
   * holds on its base.
   */
  "SATISFIED",
  /** A worker asked for the task to be split; PLANNING asks the council for subtasks. */
  "NEEDS_SPLIT",
  /** Replaced by subtasks (`splitFrom` on each). Done only when they are. */
  "SPLIT",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TASK_TABLE: TransitionTable<TaskState> = {
  initial: "PENDING",
  states: TaskStateSchema.options,
  terminal: ["INTEGRATED", "REJECTED", "CANCELLED", "SATISFIED", "SPLIT"],
  edges: {
    PENDING: ["READY", "CANCELLED"],
    READY: ["RUNNING", "CANCELLED"],
    RUNNING: ["GATED", "READY", "BLOCKED", "CANCELLED", "SATISFIED", "NEEDS_SPLIT"],
    GATED: ["SELECTED", "READY", "BLOCKED", "CANCELLED"],
    SELECTED: ["INTEGRATING", "CANCELLED"],
    INTEGRATING: ["INTEGRATED", "INTEGRATION_FAILED"],
    INTEGRATION_FAILED: ["READY", "REJECTED", "BLOCKED"],
    BLOCKED: ["READY", "REJECTED", "CANCELLED"],
    INTEGRATED: [],
    REJECTED: [],
    CANCELLED: [],
    SATISFIED: [],
    NEEDS_SPLIT: ["SPLIT", "READY", "BLOCKED", "CANCELLED"],
    SPLIT: [],
  },
};

export function isTerminalTaskState(state: TaskState): boolean {
  return TASK_TABLE.terminal.includes(state);
}

export const ComplexitySchema = z.enum(["trivial", "normal", "complex"]);

/**
 * An acceptance criterion the engine can check on a checkout by itself: the file exists, the
 * command exits 0 under the project's policy, the test file runs alone and passes.
 */
export const AcceptanceCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file_exists"), path: z.string().min(1) }),
  z.object({ kind: z.literal("command"), argv: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal("test_file"), path: z.string().min(1) }),
]);
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

const NAMED_PATH = /(?:^|[\s`'"(])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]{1,6}|[\w-]+(?:\.[\w-]+)+\.[cm]?[jt]sx?)(?=$|[\s`'"),:;]|\.(?:\s|$))/g;

/** File paths an acceptance line names, as written: what a no-change claim has to find on the base. */
export function pathsNamedByAcceptance(lines: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(NAMED_PATH)) {
      const path = (match[1] ?? "").replace(/^\.\//, "");
      if (path !== "" && !path.startsWith("../") && !/^\d+(?:\.\d+)+$/.test(path)) paths.add(path);
    }
  }
  return [...paths];
}

export const TaskSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  title: z.string().min(1),
  /** WHAT / WHY / CONSTRAINTS / EVIDENCE — never HOW */
  description: z.string().min(1),
  kind: TaskKindSchema,
  origin: TaskOriginSchema,
  acceptance: z.array(z.string().min(1)).min(1),
  /** Checks the engine runs itself; absent when the planner gave none. */
  acceptanceChecks: z.array(AcceptanceCheckSchema).optional(),
  complexity: ComplexitySchema,
  /** checkpoint the task's candidates start from; stale relative to run head => integration gates decide */
  baseCheckpointHash: GitHashSchema,
  dependsOn: z.array(IdSchema),
  state: TaskStateSchema,
  attempts: z.number().int().nonnegative(),
  /** investigation tasks never change product code */
  touchesProductCode: z.boolean(),
  selectedCandidateId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  workClass: TaskWorkClassSchema.optional(),
  classifiedBy: z.string().min(1).optional(),
  sourceRef: z.string().min(1).optional(),
  classificationEventId: IdSchema.optional(),
  /** The task this one was split from; it carries the parent's origin. */
  splitFrom: IdSchema.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/** Schema-level enforcement of the kind/origin/product-code coupling. */
export const TaskStrictSchema = TaskSchema.superRefine((t, ctx) => {
  const isInvestigation = t.kind === "investigation";
  if (isInvestigation !== (t.origin.kind === "investigation")) {
    ctx.addIssue({ code: "custom", message: "kind=investigation iff origin.kind=investigation", path: ["origin"] });
  }
  if (isInvestigation && t.touchesProductCode) {
    ctx.addIssue({ code: "custom", message: "investigation tasks must not touch product code", path: ["touchesProductCode"] });
  }
});

export interface TaskDraft {
  id: string;
  runId: string;
  title: string;
  description: string;
  kind: Exclude<TaskKind, "investigation">;
  acceptance: string[];
  acceptanceChecks?: AcceptanceCheck[];
  complexity: z.infer<typeof ComplexitySchema>;
  baseCheckpointHash: string;
  dependsOn?: string[];
  now: number;
  workClass?: TaskWorkClass;
  classifiedBy?: string;
  sourceRef?: string;
  classificationEventId?: string;
}

/** The only way to create a coding task from a finding. Throws unless the finding is VALID + blocking with a VALID validation. */
/**
 * Persist style_only only from structured planner/scope-guardian fields on a legal
 * simplify/refactor task. Missing or invalid classification fails safe to functional.
 * Investigation can never be style_only. Title/description are not consulted.
 */
export function resolveWorkClassProvenance(input: {
  kind: TaskKind;
  originKind: TaskOrigin["kind"];
  originRef: string;
  workClass?: unknown;
  classifiedBy?: unknown;
  sourceRef?: unknown;
  classificationEventId?: unknown;
}): Partial<Pick<TaskDraft, "workClass" | "classifiedBy" | "sourceRef" | "classificationEventId">> {
  const attempted =
    input.workClass !== undefined ||
    input.classifiedBy !== undefined ||
    input.sourceRef !== undefined ||
    input.classificationEventId !== undefined;
  if (input.kind === "investigation" || input.originKind === "investigation") {
    return attempted ? { workClass: "functional" } : {};
  }
  const parsed = TaskWorkClassProvenanceSchema.safeParse({
    workClass: input.workClass,
    classifiedBy: input.classifiedBy,
    sourceRef: input.sourceRef,
    classificationEventId: input.classificationEventId,
  });
  if (
    parsed.success &&
    parsed.data.workClass === "style_only" &&
    (input.kind === "simplify" || input.kind === "refactor") &&
    parsed.data.sourceRef === input.originRef
  ) {
    return parsed.data;
  }
  return attempted ? { workClass: "functional" } : {};
}

export function workClassDraftFields(
  input: Parameters<typeof resolveWorkClassProvenance>[0],
): Pick<TaskDraft, "workClass" | "classifiedBy" | "sourceRef" | "classificationEventId"> | Record<string, never> {
  const resolved = resolveWorkClassProvenance(input);
  if (resolved.workClass === "style_only" && resolved.classifiedBy !== undefined && resolved.sourceRef !== undefined && resolved.classificationEventId !== undefined) {
    return {
      workClass: "style_only",
      classifiedBy: resolved.classifiedBy,
      sourceRef: resolved.sourceRef,
      classificationEventId: resolved.classificationEventId,
    };
  }
  if (resolved.workClass === "functional") return { workClass: "functional" };
  return {};
}

export function createTaskFromValidFinding(finding: Finding, validation: FindingValidation, draft: TaskDraft): Task {
  if (finding.status !== "VALID") {
    throw new PolishError("INVARIANT_VIOLATION", "coding task requires a VALID finding", { findingId: finding.id, status: finding.status });
  }
  if (!finding.blocking) {
    throw new PolishError("INVARIANT_VIOLATION", "coding task requires a blocking finding", { findingId: finding.id });
  }
  if (validation.findingId !== finding.id || validation.verdict !== "VALID") {
    throw new PolishError("INVARIANT_VIOLATION", "validation must belong to the finding and be VALID", {
      findingId: finding.id,
      validationId: validation.id,
      verdict: validation.verdict,
    });
  }
  const strict = FindingValidationStrictSchema.safeParse(validation);
  if (!strict.success) {
    throw new PolishError("INVARIANT_VIOLATION", "VALID validation must carry evidence artifacts", {
      validationId: validation.id,
      issues: strict.error.issues.map((i) => i.message),
    });
  }
  // No model verdict creates product work: only an execution the engine judged.
  if (validation.outcome !== "demonstrated" || validation.performedBy.kind !== "system") {
    throw new PolishError("INVARIANT_VIOLATION", "a fix task requires a defect the engine demonstrated by execution", {
      validationId: validation.id,
      outcome: validation.outcome ?? null,
      performedBy: validation.performedBy.kind,
    });
  }
  return TaskStrictSchema.parse({
    ...baseTask(draft),
    kind: draft.kind,
    origin: { kind: "valid_finding", findingId: finding.id, validationId: validation.id, verdict: "VALID" },
    touchesProductCode: true,
    ...resolveWorkClassProvenance({
      kind: draft.kind,
      originKind: "valid_finding",
      originRef: finding.id,
      workClass: draft.workClass,
      classifiedBy: draft.classifiedBy,
      sourceRef: draft.sourceRef,
      classificationEventId: draft.classificationEventId,
    }),
  });
}

export function createTaskFromRequirement(interpretationId: string, requirementRef: string, draft: TaskDraft): Task {
  return TaskStrictSchema.parse({
    ...baseTask(draft),
    kind: draft.kind,
    origin: { kind: "mission_requirement", interpretationId, requirementRef },
    touchesProductCode: true,
    ...resolveWorkClassProvenance({
      kind: draft.kind,
      originKind: "mission_requirement",
      originRef: requirementRef,
      workClass: draft.workClass,
      classifiedBy: draft.classifiedBy,
      sourceRef: draft.sourceRef,
      classificationEventId: draft.classificationEventId,
    }),
  });
}

/** Investigation tasks: allowed from UNCERTAIN findings only, bounded by `maxRounds`, never touch product code. */
export function createInvestigationTask(
  finding: Finding,
  maxRounds: number,
  draft: Omit<TaskDraft, "kind">,
): Task {
  if (finding.status !== "UNCERTAIN") {
    throw new PolishError("INVARIANT_VIOLATION", "investigation task requires an UNCERTAIN finding", {
      findingId: finding.id,
      status: finding.status,
    });
  }
  const round = finding.investigationRounds + 1;
  if (round > maxRounds) {
    throw new PolishError("INVARIANT_VIOLATION", "investigation rounds exhausted; escalate to NEEDS_HUMAN", {
      findingId: finding.id,
      round,
      maxRounds,
    });
  }
  return TaskStrictSchema.parse({
    ...baseTask({ ...draft, kind: "bugfix" }),
    kind: "investigation",
    origin: { kind: "investigation", findingId: finding.id, round },
    touchesProductCode: false,
    ...resolveWorkClassProvenance({
      kind: "investigation",
      originKind: "investigation",
      originRef: finding.id,
      workClass: draft.workClass,
      classifiedBy: draft.classifiedBy,
      sourceRef: draft.sourceRef,
      classificationEventId: draft.classificationEventId,
    }),
  });
}

/**
 * A part of a task the council split. It keeps the parent's origin and kind, so a subtask can
 * only exist where its parent could: it is the same work, planned in smaller pieces.
 */
export function createSplitSubtask(
  parent: Task,
  draft: Omit<TaskDraft, "kind" | "runId" | "baseCheckpointHash"> & { baseCheckpointHash?: string },
): Task {
  if (parent.state !== "NEEDS_SPLIT") {
    throw new PolishError("INVARIANT_VIOLATION", "only a task in NEEDS_SPLIT can be split", { taskId: parent.id, state: parent.state });
  }
  if (parent.kind === "investigation" || !parent.touchesProductCode) {
    throw new PolishError("INVARIANT_VIOLATION", "only a coding task can be split", { taskId: parent.id });
  }
  return TaskStrictSchema.parse({
    ...baseTask({ ...draft, kind: parent.kind, runId: parent.runId, baseCheckpointHash: draft.baseCheckpointHash ?? parent.baseCheckpointHash }),
    kind: parent.kind,
    origin: parent.origin,
    touchesProductCode: true,
    splitFrom: parent.id,
    ...(parent.workClass === undefined ? {} : { workClass: parent.workClass }),
    ...(parent.classifiedBy === undefined ? {} : { classifiedBy: parent.classifiedBy }),
    ...(parent.sourceRef === undefined ? {} : { sourceRef: parent.sourceRef }),
    ...(parent.classificationEventId === undefined ? {} : { classificationEventId: parent.classificationEventId }),
  });
}

function baseTask(draft: TaskDraft): Omit<Task, "kind" | "origin" | "touchesProductCode"> {
  return {
    id: draft.id,
    runId: draft.runId,
    title: draft.title,
    description: draft.description,
    acceptance: draft.acceptance,
    ...(draft.acceptanceChecks === undefined || draft.acceptanceChecks.length === 0 ? {} : { acceptanceChecks: draft.acceptanceChecks }),
    complexity: draft.complexity,
    baseCheckpointHash: draft.baseCheckpointHash,
    dependsOn: draft.dependsOn ?? [],
    state: "PENDING",
    attempts: 0,
    selectedCandidateId: null,
    createdAt: draft.now,
    updatedAt: draft.now,
  };
}

/**
 * A dependency is settled when its work is done on the run: integrated, shown to already hold, or
 * split into subtasks that are all settled themselves.
 */
export function dependencySettled(dependencyId: string, tasks: readonly Task[], seen = new Set<string>()): boolean {
  if (seen.has(dependencyId)) return false;
  seen.add(dependencyId);
  const dependency = tasks.find((task) => task.id === dependencyId);
  if (dependency === undefined) return false;
  if (dependency.state === "INTEGRATED" || dependency.state === "SATISFIED") return true;
  if (dependency.state !== "SPLIT") return false;
  const parts = tasks.filter((task) => task.splitFrom === dependencyId);
  return parts.length > 0 && parts.every((part) => dependencySettled(part.id, tasks, seen));
}

export function dependenciesSettled(task: Task, tasks: readonly Task[]): boolean {
  return task.dependsOn.every((dependencyId) => dependencySettled(dependencyId, tasks));
}

export function isStale(task: Task, runHeadHash: string): boolean {
  return task.baseCheckpointHash !== runHeadHash;
}
