import type { z } from "zod";
import { AcceptanceArtifactSchema } from "../domain/acceptance.js";
import { CandidateSchema } from "../domain/candidate.js";
import { BaselineSnapshotSchema } from "../domain/checks.js";
import { CheckpointSchema } from "../domain/checkpoint.js";
import { CleanRoundSchema } from "../domain/convergence.js";
import type { Event } from "../domain/event.js";
import { FactStrictSchema } from "../domain/fact.js";
import { FindingSchema, FindingValidationStrictSchema } from "../domain/finding.js";
import { JobSchema } from "../domain/job.js";
import { MissionInterpretationSchema, MissionSchema } from "../domain/mission.js";
import { RunSchema } from "../domain/run.js";
import { TaskStrictSchema } from "../domain/task.js";
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
  | "jobs";

interface TableSpec {
  schema: z.ZodType;
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
  { eventType: "job.created", payloadField: "job", table: "jobs" },
  { eventType: "job.state_changed", payloadField: "job", table: "jobs" },
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

/** Apply all projection rules matching the event. Validation errors propagate (and abort the enclosing transaction). */
export function applyProjections(db: Db, event: Event): void {
  for (const rule of rulesByType.get(event.type) ?? []) {
    const entity = event.payload[rule.payloadField];
    if (entity === undefined) continue;
    upsertEntity(db, rule.table, entity);
  }
}

export const PROJECTED_TABLES = Object.keys(TABLE_SPECS) as ProjectedTable[];
