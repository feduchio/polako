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
  "QUEUED_FOR_INTEGRATION",
  "INTEGRATING",
  "INTEGRATED",
  "INTEGRATION_FAILED",
  "REJECTED",
  "BLOCKED",
  "CANCELLED",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TASK_TABLE: TransitionTable<TaskState> = {
  initial: "PENDING",
  states: TaskStateSchema.options,
  terminal: ["INTEGRATED", "REJECTED", "CANCELLED"],
  edges: {
    PENDING: ["READY", "CANCELLED"],
    READY: ["RUNNING", "CANCELLED"],
    RUNNING: ["GATED", "READY", "BLOCKED", "CANCELLED"],
    GATED: ["SELECTED", "READY", "BLOCKED", "CANCELLED"],
    SELECTED: ["QUEUED_FOR_INTEGRATION", "CANCELLED"],
    QUEUED_FOR_INTEGRATION: ["INTEGRATING", "CANCELLED"],
    INTEGRATING: ["INTEGRATED", "INTEGRATION_FAILED"],
    INTEGRATION_FAILED: ["READY", "REJECTED", "BLOCKED"],
    BLOCKED: ["READY", "REJECTED", "CANCELLED"],
    INTEGRATED: [],
    REJECTED: [],
    CANCELLED: [],
  },
};

export const ComplexitySchema = z.enum(["trivial", "normal", "complex"]);

export const TaskSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  title: z.string().min(1),
  /** WHAT / WHY / CONSTRAINTS / EVIDENCE — never HOW */
  description: z.string().min(1),
  kind: TaskKindSchema,
  origin: TaskOriginSchema,
  acceptance: z.array(z.string().min(1)).min(1),
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
  return TaskStrictSchema.parse({
    ...baseTask(draft),
    kind: draft.kind,
    origin: { kind: "valid_finding", findingId: finding.id, validationId: validation.id, verdict: "VALID" },
    touchesProductCode: true,
  });
}

export function createTaskFromRequirement(interpretationId: string, requirementRef: string, draft: TaskDraft): Task {
  return TaskStrictSchema.parse({
    ...baseTask(draft),
    kind: draft.kind,
    origin: { kind: "mission_requirement", interpretationId, requirementRef },
    touchesProductCode: true,
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
  });
}

function baseTask(draft: TaskDraft): Omit<Task, "kind" | "origin" | "touchesProductCode"> {
  return {
    id: draft.id,
    runId: draft.runId,
    title: draft.title,
    description: draft.description,
    acceptance: draft.acceptance,
    complexity: draft.complexity,
    baseCheckpointHash: draft.baseCheckpointHash,
    dependsOn: draft.dependsOn ?? [],
    state: "PENDING",
    attempts: 0,
    selectedCandidateId: null,
    createdAt: draft.now,
    updatedAt: draft.now,
    ...(draft.workClass === undefined ? {} : { workClass: draft.workClass }),
    ...(draft.classifiedBy === undefined ? {} : { classifiedBy: draft.classifiedBy }),
    ...(draft.sourceRef === undefined ? {} : { sourceRef: draft.sourceRef }),
    ...(draft.classificationEventId === undefined ? {} : { classificationEventId: draft.classificationEventId }),
  };
}

export function isStale(task: Task, runHeadHash: string): boolean {
  return task.baseCheckpointHash !== runHeadHash;
}
