import { z, type ZodType } from "zod";
import { AcceptanceArtifactSchema, CorpusEntrySchema } from "../domain/acceptance.js";
import { CandidateSchema } from "../domain/candidate.js";
import { BaselineSnapshotSchema } from "../domain/checks.js";
import { CheckpointSchema } from "../domain/checkpoint.js";
import { CleanRoundSchema } from "../domain/convergence.js";
import type { Event } from "../domain/event.js";
import { FactStrictSchema, assertVerifiedFactEvidence } from "../domain/fact.js";
import { FindingSchema, FindingValidationStrictSchema } from "../domain/finding.js";
import { JobSchema } from "../domain/job.js";
import { MissionInterpretationSchema, MissionSchema } from "../domain/mission.js";
import { ProtectedChangeWaiverSchema } from "../domain/protectedChangeWaiver.js";
import { RunSchema } from "../domain/run.js";
import { TaskStrictSchema } from "../domain/task.js";
import { modelRefKey, ModelRefSchema } from "../domain/common.js";
import { PolishError } from "../shared/errors.js";
import type { Db } from "./db.js";

/**
 * Projection rules: an event carrying a full entity snapshot in `payload[field]` upserts
 * that entity. Replaying all events for a run in `seq` order reproduces every projection.
 * Rules are data so tests can assert every projected table has at least one producing event.
 */
export interface ProjectionRule {
  eventType: string;
  payloadField: string;
  table: ProjectedTable;
}

export type ProjectedTable =
  | "runs"
  | "missions"
  | "interpretations"
  | "baselines"
  | "tasks"
  | "candidates"
  | "checkpoints"
  | "findings"
  | "finding_validations"
  | "clean_rounds"
  | "facts"
  | "acceptance_artifacts"
  | "acceptance_corpus_entries"
  | "protected_change_waivers"
  | "jobs"
  | "model_observations";

const ModelObservationSchema = z.union([
  z.object({
    id: z.string().min(1),
    kind: z.literal("call"),
    model: ModelRefSchema,
    observedAt: z.number().int().nonnegative(),
    outcome: z.object({
      ok: z.boolean(),
      latencyMs: z.number(),
      errorKind: z.string().optional(),
    }),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("quality"),
    model: ModelRefSchema,
    observedAt: z.number().int().nonnegative(),
    quality: z.number().min(0).max(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("audition"),
    model: ModelRefSchema,
    observedAt: z.number().int().nonnegative(),
    taskId: z.string().min(1),
    score: z.number().min(0).max(1),
    detail: z.string().optional(),
  }),
]);

interface TableSpec {
  schema: ZodType;
  columns: (entity: Record<string, unknown>) => Record<string, string | number | null>;
}

const TABLE_SPECS: Record<ProjectedTable, TableSpec> = {
  runs: {
    schema: RunSchema,
    columns: (e) => ({ mission_id: str(e["missionId"]), phase: str(e["phase"]), control: str(e["control"]), updated_at: num(e["updatedAt"]) }),
  },
  missions: { schema: MissionSchema, columns: (e) => ({ hash: str(e["hash"]) }) },
  interpretations: {
    schema: MissionInterpretationSchema,
    columns: (e) => ({ mission_id: str(e["missionId"]), version: num(e["version"]) }),
  },
  baselines: { schema: BaselineSnapshotSchema, columns: (e) => ({ run_id: str(e["runId"]) }) },
  tasks: {
    schema: TaskStrictSchema,
    columns: (e) => ({ run_id: str(e["runId"]), state: str(e["state"]), kind: str(e["kind"]), updated_at: num(e["updatedAt"]) }),
  },
  candidates: {
    schema: CandidateSchema,
    columns: (e) => ({ run_id: str(e["runId"]), task_id: str(e["taskId"]), state: str(e["state"]) }),
  },
  checkpoints: {
    schema: CheckpointSchema,
    columns: (e) => ({ run_id: str(e["runId"]), seq: num(e["seq"]), commit_hash: str(e["commitHash"]) }),
  },
  findings: {
    schema: FindingSchema,
    columns: (e) => ({
      run_id: str(e["runId"]),
      checkpoint_hash: str(e["checkpointHash"]),
      status: str(e["status"]),
      fingerprint: str(e["fingerprint"]),
    }),
  },
  finding_validations: {
    schema: FindingValidationStrictSchema,
    columns: (e) => ({ run_id: str(e["runId"]), finding_id: str(e["findingId"]), verdict: str(e["verdict"]) }),
  },
  clean_rounds: {
    schema: CleanRoundSchema,
    columns: (e) => ({ run_id: str(e["runId"]), checkpoint_hash: str(e["checkpointHash"]), round_index: num(e["roundIndex"]) }),
  },
  facts: {
    schema: FactStrictSchema,
    columns: (e) => ({
      run_id: str(e["runId"]),
      kind: str(e["kind"]),
      provenance_kind: str(e["provenanceKind"]),
      superseded_by: optStr(e["supersededBy"]),
    }),
  },
  acceptance_artifacts: {
    schema: AcceptanceArtifactSchema,
    columns: (e) => ({ run_id: str(e["runId"]), task_id: optStr(e["taskId"]), relative_path: str(e["relativePath"]), sha256: str(e["sha256"]) }),
  },
  acceptance_corpus_entries: {
    schema: CorpusEntrySchema,
    columns: (e) => ({
      mission_id: str(e["missionId"]),
      source_run_id: str(e["sourceRunId"]),
      kind: str(e["kind"]),
      created_at: num(e["createdAt"]),
    }),
  },
  protected_change_waivers: {
    schema: ProtectedChangeWaiverSchema,
    columns: (e) => ({
      run_id: str(e["runId"]),
      mission_id: str(e["missionId"]),
      task_id: str(e["taskId"]),
      requirement_id: str(e["requirementId"]),
      path_scope: JSON.stringify(e["pathScope"]),
      finding_kind: str(e["findingKind"]),
      base_checkpoint_hash: str(e["baseCheckpointHash"]),
    }),
  },
  jobs: {
    schema: JobSchema,
    columns: (e) => ({
      run_id: str(e["runId"]),
      lane: str(e["lane"]),
      state: str(e["state"]),
      priority: num(e["priority"]),
      lease_until: optNum(e["leaseUntil"]),
      created_at: num(e["createdAt"]),
    }),
  },
  model_observations: {
    schema: ModelObservationSchema,
    columns: (e) => ({
      model_key: modelRefKey(e["model"] as { provider: string; model: string }),
      kind: str(e["kind"]),
      observed_at: num(e["observedAt"]),
    }),
  },
};

function str(v: unknown): string {
  if (typeof v !== "string") throw new TypeError(`expected string column value, got ${typeof v}`);
  return v;
}
function num(v: unknown): number {
  if (typeof v !== "number") throw new TypeError(`expected number column value, got ${typeof v}`);
  return v;
}
function optStr(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}
function optNum(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

export const PROJECTION_RULES: readonly ProjectionRule[] = [
  { eventType: "run.created", payloadField: "run", table: "runs" },
  { eventType: "run.phase_changed", payloadField: "run", table: "runs" },
  { eventType: "run.control_changed", payloadField: "run", table: "runs" },
  { eventType: "run.terminated", payloadField: "run", table: "runs" },
  { eventType: "mission.recorded", payloadField: "mission", table: "missions" },
  { eventType: "mission.interpreted", payloadField: "interpretation", table: "interpretations" },
  { eventType: "baseline.snapshotted", payloadField: "baseline", table: "baselines" },
  { eventType: "task.created", payloadField: "task", table: "tasks" },
  { eventType: "task.state_changed", payloadField: "task", table: "tasks" },
  { eventType: "candidate.created", payloadField: "candidate", table: "candidates" },
  { eventType: "candidate.state_changed", payloadField: "candidate", table: "candidates" },
  { eventType: "candidate.gated", payloadField: "candidate", table: "candidates" },
  { eventType: "checkpoint.created", payloadField: "checkpoint", table: "checkpoints" },
  { eventType: "finding.raised", payloadField: "finding", table: "findings" },
  { eventType: "finding.status_changed", payloadField: "finding", table: "findings" },
  { eventType: "finding.validated", payloadField: "validation", table: "finding_validations" },
  { eventType: "finding.validated", payloadField: "finding", table: "findings" },
  { eventType: "clean_round.recorded", payloadField: "cleanRound", table: "clean_rounds" },
  { eventType: "fact.recorded", payloadField: "fact", table: "facts" },
  { eventType: "fact.promoted", payloadField: "fact", table: "facts" },
  { eventType: "fact.superseded", payloadField: "fact", table: "facts" },
  { eventType: "acceptance.recorded", payloadField: "artifact", table: "acceptance_artifacts" },
  { eventType: "corpus.entry_added", payloadField: "entry", table: "acceptance_corpus_entries" },
  { eventType: "protected_change.waiver_recorded", payloadField: "waiver", table: "protected_change_waivers" },
  { eventType: "job.created", payloadField: "job", table: "jobs" },
  { eventType: "job.state_changed", payloadField: "job", table: "jobs" },
  { eventType: "job.cancel_requested", payloadField: "job", table: "jobs" },
  { eventType: "model.observation.recorded", payloadField: "observation", table: "model_observations" },
];

const rulesByType = new Map<string, ProjectionRule[]>();
for (const rule of PROJECTION_RULES) {
  const list = rulesByType.get(rule.eventType) ?? [];
  list.push(rule);
  rulesByType.set(rule.eventType, list);
}

/** Upsert a validated entity into a projection table. */
export function upsertEntity(db: Db, table: ProjectedTable, entity: unknown): void {
  const spec = TABLE_SPECS[table];
  const parsed = spec.schema.parse(entity) as Record<string, unknown>;
  const cols = spec.columns(parsed);
  const names = ["id", ...Object.keys(cols), "json"];
  const values = [str(parsed["id"]), ...Object.values(cols), JSON.stringify(parsed)];
  const updates = names
    .filter((n) => n !== "id")
    .map((n) => `${n} = excluded.${n}`)
    .join(", ");
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
  ).run(...values);
}

/** Tables whose rows are scoped by `run_id` and must therefore match the event envelope. */
const RUN_SCOPED: ReadonlySet<ProjectedTable> = new Set<ProjectedTable>([
  "baselines",
  "tasks",
  "candidates",
  "checkpoints",
  "findings",
  "finding_validations",
  "clean_rounds",
  "facts",
  "acceptance_artifacts",
  "protected_change_waivers",
  "jobs",
]);

/**
 * Apply all projection rules matching the event. Validation errors propagate (and abort the
 * enclosing transaction). An entity may only be projected by an event of its own run: a
 * `runs` snapshot must have `id === event.runId`, run-scoped entities `runId === event.runId`.
 * Mission-scoped tables (`missions`, `interpretations`) are not run-bound and are not checked.
 */
export function applyProjections(db: Db, event: Event, events?: { get(id: string): Event | null }): void {
  for (const rule of rulesByType.get(event.type) ?? []) {
    const entity = event.payload[rule.payloadField];
    if (entity === undefined) continue;
    const record = entity as Record<string, unknown>;
    if (rule.table === "runs" && record["id"] !== event.runId) {
      throw new PolishError("INVARIANT_VIOLATION", "run snapshot id does not match event runId", { eventId: event.id, table: rule.table });
    }
    if (RUN_SCOPED.has(rule.table) && record["runId"] !== event.runId) {
      throw new PolishError("INVARIANT_VIOLATION", "entity runId does not match event runId", { eventId: event.id, table: rule.table });
    }
    if (rule.table === "acceptance_corpus_entries" && record["sourceRunId"] !== event.runId) {
      throw new PolishError("INVARIANT_VIOLATION", "corpus entry sourceRunId does not match event runId", {
        eventId: event.id,
        table: rule.table,
      });
    }
    if (rule.table === "acceptance_corpus_entries") {
      const sourceRunId = record["sourceRunId"];
      if (typeof sourceRunId !== "string") {
        throw new PolishError("INVARIANT_VIOLATION", "corpus sourceRunId must be a string", {
          eventId: event.id,
        });
      }
      const runRow = db.prepare("SELECT json FROM runs WHERE id = ?").get(sourceRunId) as { json: string } | undefined;
      if (!runRow) {
        throw new PolishError("INVARIANT_VIOLATION", "corpus source run does not exist", {
          eventId: event.id,
          sourceRunId: record["sourceRunId"],
        });
      }
      const runJson = JSON.parse(runRow.json) as { missionId?: unknown };
      if (runJson.missionId !== record["missionId"]) {
        throw new PolishError("INVARIANT_VIOLATION", "corpus source run does not belong to the entry mission", {
          eventId: event.id,
          sourceRunId: record["sourceRunId"],
          missionId: record["missionId"],
        });
      }
    }
    if ((rule.table === "facts") && events) {
      const fact = FactStrictSchema.parse(entity);
      assertVerifiedFactEvidence(fact, events);
    }
    upsertEntity(db, rule.table, entity);
  }
}

export const PROJECTED_TABLES = Object.keys(TABLE_SPECS) as ProjectedTable[];
